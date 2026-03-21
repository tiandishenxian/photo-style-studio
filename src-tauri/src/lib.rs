use std::{
    collections::hash_map::DefaultHasher,
    collections::{HashMap, HashSet},
    fs::{self, File},
    hash::{Hash, Hasher},
    io,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use image::{DynamicImage, GenericImageView};
use rfd::FileDialog;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;
use zip::ZipArchive;

const APP_STATE_FILE: &str = "app_state.json";
const APP_DB_FILE: &str = "app_state.sqlite3";
const IMAGE_EXTENSIONS: [&str; 9] = ["jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff", "avif"];
const DEFAULT_FALLBACK_PALETTE: [&str; 6] = [
    "#d9b08c",
    "#7d5a50",
    "#2f3e46",
    "#f2cc8f",
    "#81b29a",
    "#3d405b",
];
const PLACEHOLDER_PALETTES: [&[&str]; 4] = [
    &["#d9b08c", "#7d5a50", "#2f3e46"],
    &["#f2cc8f", "#81b29a", "#3d405b"],
    &["#d4a373", "#6b705c", "#283618"],
    &["#e07a5f", "#f4f1de", "#3d405b"],
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGroup {
    id: String,
    name: String,
    description: String,
    #[serde(default)]
    photographer_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPhotoMeta {
    group_id: Option<String>,
    tags: Vec<String>,
    palette: Vec<String>,
    mood: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    starred: bool,
    #[serde(default)]
    content_hash: Option<String>,
    #[serde(default)]
    hidden_duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPhoto {
    path: String,
    name: String,
    origin_path: String,
    photographer_name: String,
    group_id: Option<String>,
    tags: Vec<String>,
    palette: Vec<String>,
    mood: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    starred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLibrary {
    photographer_name: String,
    #[serde(default)]
    original_name: String,
    directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredArchiveLog {
    photographer_name: String,
    target_dir: String,
    extracted_files: usize,
    created_new_photographer: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppState {
    groups: Vec<StoredGroup>,
    photo_metadata: HashMap<String, StoredPhotoMeta>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    group_notes: HashMap<String, String>,
    #[serde(default)]
    group_view_positions: HashMap<String, i64>,
    #[serde(default)]
    photographer_aliases: HashMap<String, String>,
    libraries: Vec<StoredLibrary>,
    archive_logs: Vec<StoredArchiveLog>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendState {
    groups: Vec<StoredGroup>,
    photos: Vec<StoredPhoto>,
    tags: Vec<String>,
    group_notes: HashMap<String, String>,
    group_view_positions: HashMap<String, i64>,
    archive_logs: Vec<StoredArchiveLog>,
    libraries: Vec<StoredLibrary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveImportPreview {
    parsed_photographer_name: String,
    suggested_target_name: Option<String>,
    libraries: Vec<StoredLibrary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveStatePayload {
    groups: Vec<StoredGroup>,
    photos: Vec<StoredPhoto>,
    tags: Vec<String>,
    #[serde(default)]
    group_notes: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportArchiveResponse {
    photographer_name: String,
    target_dir: String,
    extracted_files: usize,
    created_new_photographer: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupViewPositionResponse {
    view_key: String,
    scroll_top: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportGroupPhotosResponse {
    target_dir: String,
    exported_files: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DedupeProgressPayload {
    processed: usize,
    total: usize,
    duplicates_found: usize,
    completed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DedupePhotosResponse {
    duplicates_found: usize,
    hidden_files: usize,
    state: FrontendState,
}

#[tauri::command]
fn load_app_state(app: AppHandle) -> Result<FrontendState, String> {
    let state = load_state(&app)?;
    build_frontend_state(state)
}

#[tauri::command]
fn save_app_state(app: AppHandle, payload: SaveStatePayload) -> Result<(), String> {
    let mut state = load_state(&app)?;
    state.groups = payload.groups;
    state.tags = payload.tags;
    state.group_notes = payload.group_notes;
    let mut next_metadata = state.photo_metadata.clone();
    for photo in payload.photos {
        let normalized_path = normalize_path_string(&photo.path);
        let previous_meta = next_metadata.get(&normalized_path).cloned();
        let previous_content_hash = previous_meta
            .as_ref()
            .and_then(|meta| meta.content_hash.clone());
        let previous_hidden_duplicate = previous_meta
            .as_ref()
            .map(|meta| meta.hidden_duplicate)
            .unwrap_or(false);
        next_metadata.insert(
            normalized_path,
            StoredPhotoMeta {
                group_id: photo.group_id,
                tags: photo.tags,
                palette: photo.palette,
                mood: photo.mood,
                summary: photo.summary,
                starred: photo.starred,
                content_hash: previous_content_hash,
                hidden_duplicate: previous_hidden_duplicate,
            },
        );
    }
    state.photo_metadata = next_metadata;
    save_state(&app, &state)
}

#[tauri::command]
fn import_image_directory(app: AppHandle) -> Result<FrontendState, String> {
    let directory = FileDialog::new()
        .set_title("请选择图片文件夹")
        .pick_folder()
        .ok_or_else(|| "你取消了文件夹选择。".to_string())?;

    let photographer_name = directory
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("未命名摄影师")
        .to_string();

    let mut state = load_state(&app)?;
    upsert_library(
        &mut state,
        photographer_name.clone(),
        photographer_name,
        normalize_path_string(&directory.to_string_lossy()),
    );
    save_state(&app, &state)?;
    build_frontend_state(state)
}

#[tauri::command]
fn preview_archive_import(app: AppHandle, archive_path: String) -> Result<ArchiveImportPreview, String> {
    let archive_path = PathBuf::from(&archive_path);

    if !archive_path.exists() {
        return Err("压缩包不存在。".into());
    }

    let extension = archive_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    if extension != "zip" {
        return Err("目前只支持 ZIP 压缩包。".into());
    }

    let file_stem = archive_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法识别压缩包名称。".to_string())?;

    let photographer_name = parse_photographer_name(file_stem)
        .ok_or_else(|| "压缩包名称需要符合“摄影师名字_xxx.zip”这种格式。".to_string())?;

    let state = load_state(&app)?;
    let suggested_target_name = resolve_alias_target(&state, &photographer_name);

    Ok(ArchiveImportPreview {
        parsed_photographer_name: photographer_name,
        suggested_target_name,
        libraries: state.libraries,
    })
}

#[tauri::command]
fn import_archive(
    app: AppHandle,
    archive_path: String,
    create_new: bool,
    target_photographer_name: Option<String>,
) -> Result<ImportArchiveResponse, String> {
    let archive_path = PathBuf::from(&archive_path);

    if !archive_path.exists() {
        return Err("压缩包不存在。".into());
    }

    let extension = archive_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    if extension != "zip" {
        return Err("目前先支持 ZIP 压缩包。".into());
    }

    let file_stem = archive_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法识别压缩包名称。".to_string())?;

    let parsed_photographer_name = parse_photographer_name(file_stem)
        .ok_or_else(|| "压缩包名称需要符合“摄影师名字_xxx.zip”这种格式。".to_string())?;

    let mut state = load_state(&app)?;
    let target_photographer_name = if create_new {
        if state
            .libraries
            .iter()
            .any(|library| library.photographer_name == parsed_photographer_name)
        {
            return Err("已经有同名摄影师了，请直接选择合并已有摄影师。".into());
        }
        parsed_photographer_name.clone()
    } else if let Some(target_name) = target_photographer_name.clone() {
        target_name
    } else if let Some(target_name) = resolve_alias_target(&state, &parsed_photographer_name) {
        target_name
    } else {
        return Err("请选择一个已有摄影师进行合并。".into());
    };

    let existing_target = state
        .libraries
        .iter()
        .find(|library| library.photographer_name == target_photographer_name)
        .cloned();

    let (target_dir, created_new_photographer, original_name) = match existing_target {
        Some(library) => (PathBuf::from(&library.directory), false, library.original_name),
        None => {
            let base_dir = FileDialog::new()
                .set_title("请选择这个摄影师第一次保存的位置")
                .pick_folder()
                .ok_or_else(|| "你取消了文件夹选择。".to_string())?;
            (
                base_dir.join(&target_photographer_name),
                true,
                parsed_photographer_name.clone(),
            )
        }
    };

    fs::create_dir_all(&target_dir).map_err(|err| err.to_string())?;
    let extracted_files = extract_zip_to_target(&archive_path, &target_dir)?;

    upsert_library(
        &mut state,
        target_photographer_name.clone(),
        original_name,
        normalize_path_string(&target_dir.to_string_lossy()),
    );
    state
        .photographer_aliases
        .insert(parsed_photographer_name.clone(), target_photographer_name.clone());

    state.archive_logs.insert(
        0,
        StoredArchiveLog {
            photographer_name: target_photographer_name.clone(),
            target_dir: normalize_path_string(&target_dir.to_string_lossy()),
            extracted_files,
            created_new_photographer,
        },
    );
    state.archive_logs.truncate(20);
    save_state(&app, &state)?;

    Ok(ImportArchiveResponse {
        photographer_name: target_photographer_name,
        target_dir: normalize_path_string(&target_dir.to_string_lossy()),
        extracted_files,
        created_new_photographer,
    })
}

#[tauri::command]
fn rename_photographer(
    app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<FrontendState, String> {
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err("摄影师名字不能为空。".into());
    }

    let mut state = load_state(&app)?;
    if state
        .libraries
        .iter()
        .any(|library| library.photographer_name == new_name && library.photographer_name != old_name)
    {
        return Err("已经有同名摄影师了。".into());
    }

    let mut found = false;
    for library in &mut state.libraries {
        if library.photographer_name == old_name {
            if library.original_name.trim().is_empty() {
                library.original_name = old_name.clone();
            }
            library.photographer_name = new_name.clone();
            found = true;
        }
    }

    if !found {
        return Err("没有找到这个摄影师。".into());
    }

    for group in &mut state.groups {
        if group.photographer_name == old_name {
            group.photographer_name = new_name.clone();
        }
    }

    for log in &mut state.archive_logs {
        if log.photographer_name == old_name {
            log.photographer_name = new_name.clone();
        }
    }

    let mut next_notes = HashMap::new();
    for (key, value) in state.group_notes {
        if let Some(rest) = key.strip_prefix(&format!("{old_name}::")) {
            next_notes.insert(format!("{new_name}::{rest}"), value);
        } else {
            next_notes.insert(key, value);
        }
    }
    state.group_notes = next_notes;

    let mut next_group_view_positions = HashMap::new();
    for (key, value) in state.group_view_positions {
        if let Some(rest) = key.strip_prefix(&format!("{old_name}::")) {
            next_group_view_positions.insert(format!("{new_name}::{rest}"), value);
        } else {
            next_group_view_positions.insert(key, value);
        }
    }
    state.group_view_positions = next_group_view_positions;

    for target in state.photographer_aliases.values_mut() {
        if *target == old_name {
            *target = new_name.clone();
        }
    }
    state
        .photographer_aliases
        .insert(old_name.clone(), new_name.clone());

    save_state(&app, &state)?;
    build_frontend_state(state)
}

#[tauri::command]
fn extract_photo_palette(photo_path: String) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&photo_path);

    if !path.exists() {
        return Err("图片不存在，无法重新提取色卡。".to_string());
    }

    Ok(extract_palette_from_image(&path).unwrap_or_else(fallback_palette))
}

#[tauri::command]
fn save_group_view_position(
    app: AppHandle,
    view_key: String,
    scroll_top: i64,
) -> Result<GroupViewPositionResponse, String> {
    let connection = open_database(&app)?;
    connection
        .execute(
            "INSERT INTO group_view_positions (view_key, scroll_top)
             VALUES (?1, ?2)
             ON CONFLICT(view_key) DO UPDATE SET scroll_top = excluded.scroll_top",
            params![view_key, scroll_top],
        )
        .map_err(|err| err.to_string())?;

    Ok(GroupViewPositionResponse { view_key, scroll_top })
}

#[tauri::command]
fn delete_group_view_position(app: AppHandle, view_key: String) -> Result<(), String> {
    let connection = open_database(&app)?;
    connection
        .execute(
            "DELETE FROM group_view_positions WHERE view_key = ?1",
            params![view_key],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn export_group_photos(
    photo_paths: Vec<String>,
    group_name: String,
) -> Result<ExportGroupPhotosResponse, String> {
    if photo_paths.is_empty() {
        return Err("当前分组里没有可导出的图片。".to_string());
    }

    let target_dir = FileDialog::new()
        .set_title(&format!("选择“{}”的导出文件夹", group_name))
        .pick_folder()
        .ok_or_else(|| "你取消了导出文件夹选择。".to_string())?;

    fs::create_dir_all(&target_dir).map_err(|err| err.to_string())?;

    let width = photo_paths.len().to_string().len().max(3);
    let mut exported_files = 0usize;

    for (index, photo_path) in photo_paths.iter().enumerate() {
        let source_path = PathBuf::from(photo_path);
        if !source_path.exists() {
            continue;
        }

        let extension = source_path
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("jpg");

        let target_path = target_dir.join(format!("{:0width$}.{}", index + 1, extension, width = width));
        fs::copy(&source_path, &target_path).map_err(|err| err.to_string())?;
        exported_files += 1;
    }

    Ok(ExportGroupPhotosResponse {
        target_dir: normalize_path_string(&target_dir.to_string_lossy()),
        exported_files,
    })
}

#[tauri::command]
fn dedupe_photos_by_content(
    app: AppHandle,
    photo_paths: Vec<String>,
) -> Result<DedupePhotosResponse, String> {
    if photo_paths.len() < 2 {
        return Ok(DedupePhotosResponse {
            duplicates_found: 0,
            hidden_files: 0,
            state: build_frontend_state(load_state(&app)?)?,
        });
    }

    let mut state = load_state(&app)?;
    let total = photo_paths.len();
    let mut processed = 0usize;
    let mut duplicates_found = 0usize;
    let mut seen_hashes: HashMap<String, String> = HashMap::new();

    for path in &photo_paths {
        let normalized_path = normalize_path_string(path);
        let meta = state
            .photo_metadata
            .entry(normalized_path.clone())
            .or_insert_with(|| default_photo_meta(&normalized_path));

        let hash = match meta.content_hash.clone() {
            Some(existing) if !existing.trim().is_empty() => existing,
            _ => {
                let computed = compute_content_hash(Path::new(&normalized_path))?;
                meta.content_hash = Some(computed.clone());
                computed
            }
        };

        if seen_hashes.contains_key(&hash) {
            meta.hidden_duplicate = true;
            duplicates_found += 1;
        } else {
            meta.hidden_duplicate = false;
            seen_hashes.insert(hash, normalized_path.clone());
        }

        processed += 1;
        let _ = app.emit(
            "dedupe-progress",
            DedupeProgressPayload {
                processed,
                total,
                duplicates_found,
                completed: false,
            },
        );
    }

    save_state(&app, &state)?;
    let frontend_state = build_frontend_state(load_state(&app)?)?;
    let _ = app.emit(
        "dedupe-progress",
        DedupeProgressPayload {
            processed: total,
            total,
            duplicates_found,
            completed: true,
        },
    );

    Ok(DedupePhotosResponse {
        duplicates_found,
        hidden_files: duplicates_found,
        state: frontend_state,
    })
}

fn build_frontend_state(state: AppState) -> Result<FrontendState, String> {
    let mut state = state;
    for library in &mut state.libraries {
        if library.original_name.trim().is_empty() {
            library.original_name = library.photographer_name.clone();
        }
    }
    if let Some(first_library) = state.libraries.first() {
        for group in &mut state.groups {
            if group.photographer_name.trim().is_empty() {
                group.photographer_name = first_library.photographer_name.clone();
            }
        }
    }

    let mut photos = Vec::new();
    let mut seen_paths = HashSet::new();

    for library in &state.libraries {
        let directory = PathBuf::from(&library.directory);
        if !directory.exists() {
            continue;
        }

        for path in collect_images(&directory)? {
            let normalized_path = normalize_path_string(&path.to_string_lossy());
            if !seen_paths.insert(normalized_path.clone()) {
                continue;
            }

            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("未命名图片")
                .to_string();
            let origin_path = path
                .strip_prefix(&directory)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            let meta = state
                .photo_metadata
                .get(&normalized_path)
                .cloned()
                .unwrap_or_else(|| default_photo_meta(&normalized_path));
        if meta.hidden_duplicate && !meta.starred {
            continue;
        }
            let palette = if meta.palette.is_empty() || looks_like_placeholder_palette(&meta.palette)
            {
                Vec::new()
            } else {
                meta.palette.clone()
            };

            let modified_timestamp = fs::metadata(&path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or(0);

            photos.push((
                modified_timestamp,
                StoredPhoto {
                    path: normalized_path,
                    name,
                    origin_path,
                    photographer_name: library.photographer_name.clone(),
                    group_id: meta.group_id,
                    tags: meta.tags,
                    palette,
                    mood: meta.mood,
                    summary: meta.summary,
                    starred: meta.starred,
                },
            ));
        }
    }

    photos.sort_by(|(left_modified, left_photo), (right_modified, right_photo)| {
        right_modified
            .cmp(left_modified)
            .then_with(|| left_photo.path.cmp(&right_photo.path))
    });

    let photos: Vec<StoredPhoto> = photos.into_iter().map(|(_, photo)| photo).collect();

    let mut known_tags = state.tags;
    let mut seen_tags: HashSet<String> = known_tags.iter().cloned().collect();
    for photo in &photos {
      for tag in &photo.tags {
          if seen_tags.insert(tag.clone()) {
              known_tags.push(tag.clone());
          }
      }
    }
    known_tags.sort();

    Ok(FrontendState {
        groups: state.groups,
        photos,
        tags: known_tags,
        group_notes: state.group_notes,
        group_view_positions: state.group_view_positions,
        archive_logs: state.archive_logs,
        libraries: state.libraries,
    })
}

fn collect_images(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut images = Vec::new();

    for entry in WalkDir::new(directory) {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }

        let extension = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();

        if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
            images.push(entry.into_path());
        }
    }

    Ok(images)
}

fn default_photo_meta(seed: &str) -> StoredPhotoMeta {
    let moods = ["冷静克制", "戏剧张力", "柔和诗意", "纪实张力"];

    let mood_index = seed
        .bytes()
        .fold(0usize, |accumulator, value| accumulator.wrapping_add(value as usize))
        % moods.len();

    StoredPhotoMeta {
        group_id: None,
        tags: Vec::new(),
        palette: Vec::new(),
        mood: moods[mood_index].to_string(),
        summary: String::new(),
        starred: false,
        content_hash: None,
        hidden_duplicate: false,
    }
}

fn fallback_palette() -> Vec<String> {
    DEFAULT_FALLBACK_PALETTE
        .iter()
        .map(|value| value.to_string())
        .collect()
}

fn compute_content_hash(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let hash = hasher.finish();
    Ok(format!("{:016x}-{}", hash, bytes.len()))
}

fn looks_like_placeholder_palette(palette: &[String]) -> bool {
    let normalized: Vec<String> = palette.iter().map(|value| value.to_ascii_lowercase()).collect();
    PLACEHOLDER_PALETTES.iter().any(|candidate| {
        normalized.len() == candidate.len()
            && normalized
                .iter()
                .zip(candidate.iter())
                .all(|(left, right)| left == right)
    })
}

fn extract_palette_from_image(path: &Path) -> Option<Vec<String>> {
    let reader = image::ImageReader::open(path).ok()?;
    let reader = reader.with_guessed_format().ok()?;
    let image = reader.decode().ok()?;
    let thumbnail = downsample_image(image);
    let pixels = collect_pixels(&thumbnail);
    if pixels.is_empty() {
        return None;
    }

    let clusters = run_kmeans(&pixels, 6, 8);
    if clusters.is_empty() {
        return None;
    }

    Some(
        clusters
            .into_iter()
            .map(|cluster| rgb_to_hex(cluster.center))
            .collect(),
    )
}

fn downsample_image(image: DynamicImage) -> DynamicImage {
    let (width, height) = image.dimensions();
    if width <= 160 && height <= 160 {
        image
    } else {
        image.thumbnail(160, 160)
    }
}

fn collect_pixels(image: &DynamicImage) -> Vec<[f32; 3]> {
    image
        .to_rgba8()
        .pixels()
        .filter(|pixel| pixel[3] > 8)
        .map(|pixel| [pixel[0] as f32, pixel[1] as f32, pixel[2] as f32])
        .collect()
}

#[derive(Clone)]
struct Cluster {
    center: [u8; 3],
    weight: usize,
}

fn run_kmeans(pixels: &[[f32; 3]], cluster_count: usize, iterations: usize) -> Vec<Cluster> {
    let mut centroids = initialize_centroids(pixels, cluster_count);
    if centroids.is_empty() {
        return Vec::new();
    }

    for _ in 0..iterations {
        let mut sums = vec![[0f32; 3]; centroids.len()];
        let mut counts = vec![0usize; centroids.len()];

        for pixel in pixels {
            let nearest = nearest_centroid(*pixel, &centroids);
            counts[nearest] += 1;
            sums[nearest][0] += pixel[0];
            sums[nearest][1] += pixel[1];
            sums[nearest][2] += pixel[2];
        }

        for (index, centroid) in centroids.iter_mut().enumerate() {
            if counts[index] == 0 {
                continue;
            }

            centroid[0] = sums[index][0] / counts[index] as f32;
            centroid[1] = sums[index][1] / counts[index] as f32;
            centroid[2] = sums[index][2] / counts[index] as f32;
        }
    }

    let mut counts = vec![0usize; centroids.len()];
    for pixel in pixels {
        let nearest = nearest_centroid(*pixel, &centroids);
        counts[nearest] += 1;
    }

    let mut clusters: Vec<Cluster> = centroids
        .into_iter()
        .zip(counts)
        .filter(|(_, weight)| *weight > 0)
        .map(|(center, weight)| Cluster {
            center: [
                center[0].round().clamp(0.0, 255.0) as u8,
                center[1].round().clamp(0.0, 255.0) as u8,
                center[2].round().clamp(0.0, 255.0) as u8,
            ],
            weight,
        })
        .collect();

    clusters.sort_by(|left, right| right.weight.cmp(&left.weight));
    dedupe_clusters(clusters, 18.0)
}

fn initialize_centroids(pixels: &[[f32; 3]], cluster_count: usize) -> Vec<[f32; 3]> {
    let mut buckets: HashMap<(u8, u8, u8), (usize, [f32; 3])> = HashMap::new();

    for pixel in pixels {
        let key = (
            (pixel[0] / 32.0).floor() as u8,
            (pixel[1] / 32.0).floor() as u8,
            (pixel[2] / 32.0).floor() as u8,
        );
        let entry = buckets.entry(key).or_insert((0usize, [0.0; 3]));
        entry.0 += 1;
        entry.1[0] += pixel[0];
        entry.1[1] += pixel[1];
        entry.1[2] += pixel[2];
    }

    let mut sorted_buckets: Vec<(usize, [f32; 3])> = buckets
        .into_values()
        .map(|(count, sum)| {
            (
                count,
                [
                    sum[0] / count as f32,
                    sum[1] / count as f32,
                    sum[2] / count as f32,
                ],
            )
        })
        .collect();

    sorted_buckets.sort_by(|left, right| right.0.cmp(&left.0));

    let mut centroids = Vec::new();
    for (_, candidate) in sorted_buckets {
        if centroids
            .iter()
            .any(|existing| color_distance(*existing, candidate) < 20.0)
        {
            continue;
        }

        centroids.push(candidate);
        if centroids.len() == cluster_count {
            break;
        }
    }

    if centroids.is_empty() {
        centroids.push(pixels[0]);
    }

    centroids
}

fn nearest_centroid(pixel: [f32; 3], centroids: &[[f32; 3]]) -> usize {
    let mut nearest_index = 0usize;
    let mut nearest_distance = f32::MAX;

    for (index, centroid) in centroids.iter().enumerate() {
        let distance = color_distance(*centroid, pixel);
        if distance < nearest_distance {
            nearest_distance = distance;
            nearest_index = index;
        }
    }

    nearest_index
}

fn dedupe_clusters(clusters: Vec<Cluster>, threshold: f32) -> Vec<Cluster> {
    let mut deduped = Vec::new();

    for cluster in clusters {
        let candidate = [
            cluster.center[0] as f32,
            cluster.center[1] as f32,
            cluster.center[2] as f32,
        ];

        if deduped.iter().any(|existing: &Cluster| {
            let existing_color = [
                existing.center[0] as f32,
                existing.center[1] as f32,
                existing.center[2] as f32,
            ];
            color_distance(existing_color, candidate) < threshold
        }) {
            continue;
        }

        deduped.push(cluster);
        if deduped.len() == 6 {
            break;
        }
    }

    deduped
}

fn color_distance(left: [f32; 3], right: [f32; 3]) -> f32 {
    let red = left[0] - right[0];
    let green = left[1] - right[1];
    let blue = left[2] - right[2];
    (red * red + green * green + blue * blue).sqrt()
}

fn rgb_to_hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

fn upsert_library(
    state: &mut AppState,
    photographer_name: String,
    original_name: String,
    directory: String,
) {
    if let Some(existing) = state
        .libraries
        .iter_mut()
        .find(|library| library.photographer_name == photographer_name)
    {
        if existing.original_name.trim().is_empty() {
            existing.original_name = original_name;
        }
        existing.directory = directory;
    } else {
        state.libraries.push(StoredLibrary {
            photographer_name,
            original_name,
            directory,
        });
    }
}

fn resolve_alias_target(state: &AppState, photographer_name: &str) -> Option<String> {
    if let Some(mapped) = state.photographer_aliases.get(photographer_name) {
        return Some(mapped.clone());
    }

    state
        .libraries
        .iter()
        .find(|library| {
            library.photographer_name == photographer_name || library.original_name == photographer_name
        })
        .map(|library| library.photographer_name.clone())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|err| err.to_string())?;
    Ok(app_data_dir)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(APP_STATE_FILE))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(APP_DB_FILE))
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    let connection = Connection::open(path).map_err(|err| err.to_string())?;
    initialize_database(&connection)?;
    migrate_json_state_if_needed(app, &connection)?;
    Ok(connection)
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                photographer_name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS photo_metadata (
                path TEXT PRIMARY KEY,
                group_id TEXT,
                tags_json TEXT NOT NULL,
                palette_json TEXT NOT NULL,
                mood TEXT NOT NULL,
                summary TEXT NOT NULL,
                starred INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT,
                hidden_duplicate INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS tags (
                name TEXT PRIMARY KEY
            );

            CREATE TABLE IF NOT EXISTS group_notes (
                note_key TEXT PRIMARY KEY,
                note_value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS group_view_positions (
                view_key TEXT PRIMARY KEY,
                scroll_top INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS photographer_aliases (
                alias TEXT PRIMARY KEY,
                target_name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS libraries (
                photographer_name TEXT PRIMARY KEY,
                original_name TEXT NOT NULL,
                directory TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS archive_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                photographer_name TEXT NOT NULL,
                target_dir TEXT NOT NULL,
                extracted_files INTEGER NOT NULL,
                created_new_photographer INTEGER NOT NULL
            );
            ",
        )
        .map_err(|err| err.to_string())?;

    let _ = connection.execute(
        "ALTER TABLE photo_metadata ADD COLUMN starred INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE photo_metadata ADD COLUMN content_hash TEXT",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE photo_metadata ADD COLUMN hidden_duplicate INTEGER NOT NULL DEFAULT 0",
        [],
    );

    Ok(())
}

fn migrate_json_state_if_needed(app: &AppHandle, connection: &Connection) -> Result<(), String> {
    let already_migrated = connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'json_migrated'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;

    if already_migrated.is_some() {
        return Ok(());
    }

    let library_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM libraries", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;

    if library_count == 0 {
        let json_path = state_path(app)?;
        if json_path.exists() {
            let content = fs::read_to_string(&json_path).map_err(|err| err.to_string())?;
            let state: AppState = serde_json::from_str(&content).map_err(|err| err.to_string())?;
            write_full_state(connection, &state)?;
        }
    }

    connection
        .execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('json_migrated', '1')",
            [],
        )
        .map_err(|err| err.to_string())?;

    Ok(())
}

fn load_state(app: &AppHandle) -> Result<AppState, String> {
    let connection = open_database(app)?;
    read_full_state(&connection)
}

fn save_state(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let mut connection = open_database(app)?;
    write_full_state(&mut connection, state)
}

fn read_full_state(connection: &Connection) -> Result<AppState, String> {
    let mut groups_statement = connection
        .prepare(
            "SELECT id, name, description, photographer_name
             FROM groups
             ORDER BY photographer_name, name",
        )
        .map_err(|err| err.to_string())?;
    let groups = groups_statement
        .query_map([], |row| {
            Ok(StoredGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                photographer_name: row.get(3)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut metadata_statement = connection
        .prepare(
            "SELECT path, group_id, tags_json, palette_json, mood, summary, starred, content_hash, hidden_duplicate
             FROM photo_metadata",
        )
        .map_err(|err| err.to_string())?;
    let photo_metadata = metadata_statement
        .query_map([], |row| {
            let tags_json: String = row.get(2)?;
            let palette_json: String = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                StoredPhotoMeta {
                    group_id: row.get(1)?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    palette: serde_json::from_str(&palette_json).unwrap_or_default(),
                    mood: row.get(4)?,
                    summary: row.get(5)?,
                    starred: row.get::<_, i64>(6).unwrap_or(0) != 0,
                    content_hash: row.get(7).ok(),
                    hidden_duplicate: row.get::<_, i64>(8).unwrap_or(0) != 0,
                },
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|err| err.to_string())?;

    let mut tags_statement = connection
        .prepare("SELECT name FROM tags ORDER BY name")
        .map_err(|err| err.to_string())?;
    let tags = tags_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut notes_statement = connection
        .prepare("SELECT note_key, note_value FROM group_notes")
        .map_err(|err| err.to_string())?;
    let group_notes = notes_statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|err| err.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|err| err.to_string())?;

    let mut positions_statement = connection
        .prepare("SELECT view_key, scroll_top FROM group_view_positions")
        .map_err(|err| err.to_string())?;
    let group_view_positions = positions_statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|err| err.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|err| err.to_string())?;

    let mut aliases_statement = connection
        .prepare("SELECT alias, target_name FROM photographer_aliases")
        .map_err(|err| err.to_string())?;
    let photographer_aliases = aliases_statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|err| err.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|err| err.to_string())?;

    let mut libraries_statement = connection
        .prepare(
            "SELECT photographer_name, original_name, directory
             FROM libraries
             ORDER BY photographer_name",
        )
        .map_err(|err| err.to_string())?;
    let libraries = libraries_statement
        .query_map([], |row| {
            Ok(StoredLibrary {
                photographer_name: row.get(0)?,
                original_name: row.get(1)?,
                directory: row.get(2)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut logs_statement = connection
        .prepare(
            "SELECT photographer_name, target_dir, extracted_files, created_new_photographer
             FROM archive_logs
             ORDER BY id DESC
             LIMIT 20",
        )
        .map_err(|err| err.to_string())?;
    let archive_logs = logs_statement
        .query_map([], |row| {
            Ok(StoredArchiveLog {
                photographer_name: row.get(0)?,
                target_dir: row.get(1)?,
                extracted_files: row.get(2)?,
                created_new_photographer: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    Ok(AppState {
        groups,
        photo_metadata,
        tags,
        group_notes,
        group_view_positions,
        photographer_aliases,
        libraries,
        archive_logs,
    })
}

fn write_full_state(connection: &Connection, state: &AppState) -> Result<(), String> {
    let transaction = connection.unchecked_transaction().map_err(|err| err.to_string())?;
    clear_state_tables(&transaction)?;

    for group in &state.groups {
        transaction
            .execute(
                "INSERT INTO groups (id, name, description, photographer_name)
                 VALUES (?1, ?2, ?3, ?4)",
                params![group.id, group.name, group.description, group.photographer_name],
            )
            .map_err(|err| err.to_string())?;
    }

    for (path, meta) in &state.photo_metadata {
        let tags_json = serde_json::to_string(&meta.tags).map_err(|err| err.to_string())?;
        let palette_json = serde_json::to_string(&meta.palette).map_err(|err| err.to_string())?;
        transaction
            .execute(
                "INSERT INTO photo_metadata (path, group_id, tags_json, palette_json, mood, summary, starred, content_hash, hidden_duplicate)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    path,
                    meta.group_id,
                    tags_json,
                    palette_json,
                    meta.mood,
                    meta.summary,
                    if meta.starred { 1 } else { 0 },
                    meta.content_hash,
                    if meta.hidden_duplicate { 1 } else { 0 }
                ],
            )
            .map_err(|err| err.to_string())?;
    }

    for tag in &state.tags {
        transaction
            .execute("INSERT INTO tags (name) VALUES (?1)", params![tag])
            .map_err(|err| err.to_string())?;
    }

    for (key, value) in &state.group_notes {
        transaction
            .execute(
                "INSERT INTO group_notes (note_key, note_value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map_err(|err| err.to_string())?;
    }

    for (view_key, scroll_top) in &state.group_view_positions {
        transaction
            .execute(
                "INSERT INTO group_view_positions (view_key, scroll_top) VALUES (?1, ?2)",
                params![view_key, scroll_top],
            )
            .map_err(|err| err.to_string())?;
    }

    for (alias, target_name) in &state.photographer_aliases {
        transaction
            .execute(
                "INSERT INTO photographer_aliases (alias, target_name) VALUES (?1, ?2)",
                params![alias, target_name],
            )
            .map_err(|err| err.to_string())?;
    }

    for library in &state.libraries {
        transaction
            .execute(
                "INSERT INTO libraries (photographer_name, original_name, directory)
                 VALUES (?1, ?2, ?3)",
                params![library.photographer_name, library.original_name, library.directory],
            )
            .map_err(|err| err.to_string())?;
    }

    for log in &state.archive_logs {
        transaction
            .execute(
                "INSERT INTO archive_logs (photographer_name, target_dir, extracted_files, created_new_photographer)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    log.photographer_name,
                    log.target_dir,
                    log.extracted_files as i64,
                    if log.created_new_photographer { 1 } else { 0 }
                ],
            )
            .map_err(|err| err.to_string())?;
    }

    transaction.commit().map_err(|err| err.to_string())
}

fn clear_state_tables(transaction: &Transaction) -> Result<(), String> {
    for table in [
        "groups",
        "photo_metadata",
        "tags",
        "group_notes",
        "group_view_positions",
        "photographer_aliases",
        "libraries",
        "archive_logs",
    ] {
        transaction
            .execute(&format!("DELETE FROM {table}"), [])
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn parse_photographer_name(file_stem: &str) -> Option<String> {
    let normalized = file_stem.replace(' ', "");
    let photographer = normalized
        .split_once('_')
        .map(|(name, _)| name)
        .filter(|name| !name.trim().is_empty())?;

    Some(photographer.trim().to_string())
}

fn normalize_path_string(value: &str) -> String {
    value.replace('\\', "/")
}

fn extract_zip_to_target(archive_path: &Path, target_dir: &Path) -> Result<usize, String> {
    let file = File::open(archive_path).map_err(|err| err.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|err| err.to_string())?;
    let strip_prefix = detect_common_root(&mut archive)?;
    let mut extracted_files = 0usize;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
        let enclosed_path = entry
            .enclosed_name()
            .map(PathBuf::from)
            .ok_or_else(|| "压缩包中包含不安全的路径。".to_string())?;

        let relative_path = strip_common_prefix(&enclosed_path, strip_prefix.as_deref());
        if relative_path.as_os_str().is_empty() {
            continue;
        }

        let output_path = target_dir.join(relative_path);

        if entry.name().ends_with('/') {
            fs::create_dir_all(&output_path).map_err(|err| err.to_string())?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }

        let mut output_file = File::create(&output_path).map_err(|err| err.to_string())?;
        io::copy(&mut entry, &mut output_file).map_err(|err| err.to_string())?;
        extracted_files += 1;
    }

    Ok(extracted_files)
}

fn detect_common_root(archive: &mut ZipArchive<File>) -> Result<Option<PathBuf>, String> {
    let mut first_components = HashSet::new();

    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|err| err.to_string())?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };

        let mut components = enclosed.components();
        let Some(Component::Normal(first)) = components.next() else {
            continue;
        };

        first_components.insert(first.to_os_string());
        if first_components.len() > 1 {
            return Ok(None);
        }
    }

    let Some(component) = first_components.into_iter().next() else {
        return Ok(None);
    };

    Ok(Some(PathBuf::from(component)))
}

fn strip_common_prefix(path: &Path, prefix: Option<&Path>) -> PathBuf {
    if let Some(prefix) = prefix {
        if let Ok(stripped) = path.strip_prefix(prefix) {
            return stripped.to_path_buf();
        }
    }

    path.to_path_buf()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_app_state,
            save_app_state,
            import_image_directory,
            preview_archive_import,
            import_archive,
            rename_photographer,
            extract_photo_palette,
            dedupe_photos_by_content,
            export_group_photos,
            save_group_view_position,
            delete_group_view_position
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
