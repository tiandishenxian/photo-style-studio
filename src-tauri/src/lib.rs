use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
};

use image::{DynamicImage, GenericImageView};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;
use zip::ZipArchive;

const APP_STATE_FILE: &str = "app_state.json";
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
    state.photo_metadata = payload
        .photos
        .into_iter()
        .map(|photo| {
            (
                normalize_path_string(&photo.path),
                StoredPhotoMeta {
                    group_id: photo.group_id,
                    tags: photo.tags,
                    palette: photo.palette,
                    mood: photo.mood,
                    summary: photo.summary,
                },
            )
        })
        .collect();
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
            let palette = if meta.palette.is_empty() || looks_like_placeholder_palette(&meta.palette)
            {
                Vec::new()
            } else {
                meta.palette.clone()
            };

            photos.push(StoredPhoto {
                path: normalized_path,
                name,
                origin_path,
                photographer_name: library.photographer_name.clone(),
                group_id: meta.group_id,
                tags: meta.tags,
                palette,
                mood: meta.mood,
                summary: meta.summary,
            });
        }
    }

    photos.sort_by(|left, right| left.path.cmp(&right.path));

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
    }
}

fn fallback_palette() -> Vec<String> {
    DEFAULT_FALLBACK_PALETTE
        .iter()
        .map(|value| value.to_string())
        .collect()
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

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|err| err.to_string())?;
    Ok(app_data_dir.join(APP_STATE_FILE))
}

fn load_state(app: &AppHandle) -> Result<AppState, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(AppState::default());
    }

    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&content).map_err(|err| err.to_string())
}

fn save_state(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let path = state_path(app)?;
    let content = serde_json::to_string_pretty(state).map_err(|err| err.to_string())?;
    fs::write(path, content).map_err(|err| err.to_string())
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
            extract_photo_palette
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
