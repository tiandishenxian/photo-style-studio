use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    fs::{self, File},
    hash::{Hash, Hasher},
    io,
    path::{Component, Path, PathBuf},
};

use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;
use zip::ZipArchive;

const APP_STATE_FILE: &str = "app_state.json";
const IMAGE_EXTENSIONS: [&str; 9] = ["jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff", "avif"];

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
    libraries: Vec<StoredLibrary>,
    archive_logs: Vec<StoredArchiveLog>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendState {
    groups: Vec<StoredGroup>,
    photos: Vec<StoredPhoto>,
    tags: Vec<String>,
    archive_logs: Vec<StoredArchiveLog>,
    libraries: Vec<StoredLibrary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveStatePayload {
    groups: Vec<StoredGroup>,
    photos: Vec<StoredPhoto>,
    tags: Vec<String>,
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
        photographer_name,
        normalize_path_string(&directory.to_string_lossy()),
    );
    save_state(&app, &state)?;
    build_frontend_state(state)
}

#[tauri::command]
fn import_archive(app: AppHandle, archive_path: String) -> Result<ImportArchiveResponse, String> {
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

    let photographer_name = parse_photographer_name(file_stem)
        .ok_or_else(|| "压缩包名称需要符合“摄影师名字_xxx.zip”这种格式。".to_string())?;

    let mut state = load_state(&app)?;
    let existing_target = state
        .libraries
        .iter()
        .find(|library| library.photographer_name == photographer_name)
        .map(|library| PathBuf::from(&library.directory));

    let (target_dir, created_new_photographer) = match existing_target {
        Some(path) => (path, false),
        None => {
            let base_dir = FileDialog::new()
                .set_title("请选择这个摄影师第一次保存的位置")
                .pick_folder()
                .ok_or_else(|| "你取消了文件夹选择。".to_string())?;
            (base_dir.join(&photographer_name), true)
        }
    };

    fs::create_dir_all(&target_dir).map_err(|err| err.to_string())?;
    let extracted_files = extract_zip_to_target(&archive_path, &target_dir)?;

    upsert_library(
        &mut state,
        photographer_name.clone(),
        normalize_path_string(&target_dir.to_string_lossy()),
    );

    state.archive_logs.insert(
        0,
        StoredArchiveLog {
            photographer_name: photographer_name.clone(),
            target_dir: normalize_path_string(&target_dir.to_string_lossy()),
            extracted_files,
            created_new_photographer,
        },
    );
    state.archive_logs.truncate(20);
    save_state(&app, &state)?;

    Ok(ImportArchiveResponse {
        photographer_name,
        target_dir: normalize_path_string(&target_dir.to_string_lossy()),
        extracted_files,
        created_new_photographer,
    })
}

fn build_frontend_state(state: AppState) -> Result<FrontendState, String> {
    let mut state = state;
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

            photos.push(StoredPhoto {
                path: normalized_path,
                name,
                origin_path,
                photographer_name: library.photographer_name.clone(),
                group_id: meta.group_id,
                tags: meta.tags,
                palette: meta.palette,
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
    let palettes = [
        vec!["#d9b08c".to_string(), "#7d5a50".to_string(), "#2f3e46".to_string()],
        vec!["#f2cc8f".to_string(), "#81b29a".to_string(), "#3d405b".to_string()],
        vec!["#d4a373".to_string(), "#6b705c".to_string(), "#283618".to_string()],
        vec!["#e07a5f".to_string(), "#f4f1de".to_string(), "#3d405b".to_string()],
    ];
    let moods = ["冷静克制", "戏剧张力", "柔和诗意", "纪实张力"];

    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    let value = hasher.finish() as usize;

    StoredPhotoMeta {
        group_id: None,
        tags: Vec::new(),
        palette: palettes[value % palettes.len()].clone(),
        mood: moods[value % moods.len()].to_string(),
        summary: String::new(),
    }
}

fn upsert_library(state: &mut AppState, photographer_name: String, directory: String) {
    if let Some(existing) = state
        .libraries
        .iter_mut()
        .find(|library| library.photographer_name == photographer_name)
    {
        existing.directory = directory;
    } else {
        state.libraries.push(StoredLibrary {
            photographer_name,
            directory,
        });
    }
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
            import_archive
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
