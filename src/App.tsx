import { useEffect, useMemo, useState, type WheelEvent as ReactWheelEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Info,
  MoreHorizontal,
  Palette,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload,
} from "lucide-react";
import "./App.css";

type PhotoItem = {
  path: string;
  name: string;
  originPath: string;
  photographerName: string;
  groupId: string | null;
  tags: string[];
  palette: string[];
  mood: string;
  summary: string;
  previewSrc: string;
};

type PersistedPhoto = Omit<PhotoItem, "previewSrc">;

type StyleGroup = {
  id: string;
  name: string;
  description: string;
  photographerName: string;
};

type ArchiveLog = {
  photographerName: string;
  targetDir: string;
  extractedFiles: number;
  createdNewPhotographer: boolean;
};

type LibraryEntry = {
  photographerName: string;
  directory: string;
};

type FrontendState = {
  groups: StyleGroup[];
  photos: PersistedPhoto[];
  tags: string[];
  archiveLogs: ArchiveLog[];
  libraries: LibraryEntry[];
};

type ArchiveImportResult = {
  photographerName: string;
  targetDir: string;
  extractedFiles: number;
  createdNewPhotographer: boolean;
};

type TreeGroup = {
  id: string;
  name: string;
  count: number;
};

type ArtistTreeEntry = {
  photographerName: string;
  directory: string;
  count: number;
  groups: TreeGroup[];
};

type PendingDeleteTarget =
  | {
      type: "group";
      id: string;
      name: string;
    }
  | {
      type: "tag";
      name: string;
    };

type ImageMetrics = {
  width: number;
  height: number;
};

const TEXT = {
  appName: "Style Studio",
  searchArtist: "搜索摄影师...",
  importAssets: "导入资源",
  importHint: "支持文件夹导入，也支持直接拖入 ZIP",
  library: "资料库",
  noPhotographer: "还没有摄影师",
  noPhotographerHint: "先导入摄影师文件夹，或者直接把 ZIP 压缩包拖进窗口。",
  allImages: "全部图片",
  ungrouped: "未分组",
  chooseImage: "请选择一张图片",
  chooseImageHint: "右侧会显示色卡、分组、标签和总结。",
  filmstrip: "胶片轴",
  palette: "PALETTE",
  currentGroup: "GROUP",
  tags: "TAGS",
  summary: "SUMMARY",
  createGroup: "新建分组",
  createGroupName: "例如：柔雾人像",
  createGroupAction: "创建分组",
  cancel: "取消",
  deleteGroup: "删除分组",
  deleteTag: "删除标签",
  deleteGroupMessage: "删除后，这个分组里的图片都会回到未分组。",
  deleteTagMessage: "删除后，这个标签会从当前图片移除。",
  deleteConfirm: "确认删除",
  dropHint: "命名格式：摄影师名字_xxx.zip。同名摄影师会自动合并。",
  dropReady: "松开鼠标即可导入当前 ZIP 压缩包。",
  importSuccessNew: "已创建并导入这个摄影师。",
  importSuccessMerge: "已合并到已有摄影师文件夹。",
  loading: "正在加载...",
  importing: "正在导入...",
  unsupportedArchive: "目前只支持 ZIP 压缩包。",
  saveError: "保存失败",
  loadError: "加载失败",
  importError: "导入失败",
  groupDefaultDescription: "新的风格分组",
  artistNotSelected: "未选择摄影师",
  photoNotSelected: "未选择图片",
  emptyPalette: "选择图片后显示色卡",
  copiedValue: "已复制",
};

const FALLBACK_PALETTE = [
  "#d9b08c",
  "#7d5a50",
  "#f2cc8f",
  "#81b29a",
  "#33405b",
  "#b8c1ec",
];

function hydratePhotos(photos: PersistedPhoto[]): PhotoItem[] {
  return photos.map((photo) => ({
    ...photo,
    previewSrc: convertFileSrc(photo.path),
  }));
}

function buildPalette(colors: string[]) {
  return Array.from(new Set([...colors, ...FALLBACK_PALETTE])).slice(0, 6);
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((item) => `${item}${item}`)
          .join("")
      : normalized;

  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `${red}, ${green}, ${blue}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  if (!right) {
    return left;
  }

  return greatestCommonDivisor(right, left % right);
}

function formatAspectRatio(width: number, height: number) {
  if (!width || !height) {
    return "-";
  }

  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function toArtistTree(
  libraries: LibraryEntry[],
  photos: PhotoItem[],
  groups: StyleGroup[],
  searchArtist: string,
): ArtistTreeEntry[] {
  const keyword = searchArtist.trim().toLowerCase();

  return libraries
    .filter((library) => library.photographerName.toLowerCase().includes(keyword))
    .map((library) => {
      const photographerPhotos = photos.filter(
        (photo) => photo.photographerName === library.photographerName,
      );
      const photographerGroups = groups.filter(
        (group) => group.photographerName === library.photographerName,
      );

      return {
        ...library,
        count: photographerPhotos.length,
        groups: [
          { id: "all", name: TEXT.allImages, count: photographerPhotos.length },
          {
            id: "unassigned",
            name: TEXT.ungrouped,
            count: photographerPhotos.filter((photo) => !photo.groupId).length,
          },
          ...photographerGroups.map((group) => ({
            id: group.id,
            name: group.name,
            count: photographerPhotos.filter((photo) => photo.groupId === group.id).length,
          })),
        ],
      };
    });
}

function App() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [groups, setGroups] = useState<StyleGroup[]>([]);
  const [tagLibrary, setTagLibrary] = useState<string[]>([]);
  const [libraries, setLibraries] = useState<LibraryEntry[]>([]);
  const [searchArtist, setSearchArtist] = useState("");
  const [expandedArtist, setExpandedArtist] = useState<string | null>(null);
  const [activeGroupId, setActiveGroupId] = useState("all");
  const [selectedPhotoPath, setSelectedPhotoPath] = useState<string | null>(null);
  const [createGroupArtist, setCreateGroupArtist] = useState<string | null>(null);
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<PendingDeleteTarget | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [createTagOpen, setCreateTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [statusMessage, setStatusMessage] = useState(TEXT.loading);
  const [hydrated, setHydrated] = useState(false);
  const [copiedPaletteValue, setCopiedPaletteValue] = useState<string | null>(null);
  const [imageMetrics, setImageMetrics] = useState<ImageMetrics | null>(null);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const state = await invoke<FrontendState>("load_app_state");
        applyState(state);
        setStatusMessage("");
      } catch (error) {
        setStatusMessage(
          error instanceof Error ? error.message : String(error ?? TEXT.loadError),
        );
      } finally {
        setHydrated(true);
      }
    };

    void bootstrap();
  }, []);

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | undefined;

    const setup = async () => {
      const unlisten = await getCurrentWindow().onDragDropEvent(async (event) => {
        if (!active) {
          return;
        }

        if (event.payload.type === "enter") {
          setDragActive(true);
          return;
        }

        if (event.payload.type === "leave") {
          setDragActive(false);
          return;
        }

        setDragActive(false);
        if (event.payload.type !== "drop") {
          return;
        }

        const firstPath = event.payload.paths[0];
        if (!firstPath) {
          return;
        }

        await handleArchiveDrop(firstPath);
      });

      cleanup = unlisten;
    };

    void setup();

    return () => {
      active = false;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const payload = {
      groups,
      tags: tagLibrary,
      photos: photos.map<PersistedPhoto>(({ previewSrc: _previewSrc, ...photo }) => photo),
    };

    void invoke("save_app_state", { payload }).catch((error) => {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? TEXT.saveError),
      );
    });
  }, [groups, hydrated, photos, tagLibrary]);

  useEffect(() => {
    if (!copiedPaletteValue) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopiedPaletteValue(null);
    }, 1600);

    return () => window.clearTimeout(timer);
  }, [copiedPaletteValue]);

  const artistTree = useMemo(
    () => toArtistTree(libraries, photos, groups, searchArtist),
    [groups, libraries, photos, searchArtist],
  );

  useEffect(() => {
    if (artistTree.length === 0) {
      setExpandedArtist(null);
      return;
    }

    if (
      !expandedArtist ||
      !artistTree.some((artist) => artist.photographerName === expandedArtist)
    ) {
      setExpandedArtist(artistTree[0].photographerName);
    }
  }, [artistTree, expandedArtist]);

  const currentArtist = expandedArtist;

  const currentArtistGroups = useMemo(() => {
    if (!currentArtist) {
      return [];
    }

    return groups.filter((group) => group.photographerName === currentArtist);
  }, [currentArtist, groups]);

  useEffect(() => {
    if (activeGroupId === "all" || activeGroupId === "unassigned") {
      return;
    }

    if (!currentArtistGroups.some((group) => group.id === activeGroupId)) {
      setActiveGroupId("all");
    }
  }, [activeGroupId, currentArtistGroups]);

  const currentArtistPhotos = useMemo(() => {
    if (!currentArtist) {
      return [];
    }

    return photos.filter((photo) => photo.photographerName === currentArtist);
  }, [currentArtist, photos]);

  const visiblePhotos = useMemo(() => {
    if (activeGroupId === "all") {
      return currentArtistPhotos;
    }

    if (activeGroupId === "unassigned") {
      return currentArtistPhotos.filter((photo) => !photo.groupId);
    }

    return currentArtistPhotos.filter((photo) => photo.groupId === activeGroupId);
  }, [activeGroupId, currentArtistPhotos]);

  useEffect(() => {
    if (visiblePhotos.length === 0) {
      setSelectedPhotoPath(null);
      return;
    }

    if (!selectedPhotoPath || !visiblePhotos.some((photo) => photo.path === selectedPhotoPath)) {
      setSelectedPhotoPath(visiblePhotos[0].path);
    }
  }, [selectedPhotoPath, visiblePhotos]);

  const selectedPhoto = useMemo(
    () => visiblePhotos.find((photo) => photo.path === selectedPhotoPath) ?? null,
    [selectedPhotoPath, visiblePhotos],
  );

  useEffect(() => {
    if (!selectedPhoto) {
      setImageMetrics(null);
      return;
    }

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) {
        return;
      }

      setImageMetrics({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };
    image.onerror = () => {
      if (!active) {
        return;
      }

      setImageMetrics(null);
    };
    image.src = selectedPhoto.previewSrc;

    return () => {
      active = false;
    };
  }, [selectedPhoto]);

  const activeGroupName = useMemo(() => {
    if (activeGroupId === "all") {
      return TEXT.allImages;
    }

    if (activeGroupId === "unassigned") {
      return TEXT.ungrouped;
    }

    return currentArtistGroups.find((group) => group.id === activeGroupId)?.name ?? TEXT.allImages;
  }, [activeGroupId, currentArtistGroups]);

  const filmstripPosition = useMemo(() => {
    if (!selectedPhoto || visiblePhotos.length === 0) {
      return "0 / 0";
    }

    const index = visiblePhotos.findIndex((photo) => photo.path === selectedPhoto.path);
    return `${index + 1} / ${visiblePhotos.length}`;
  }, [selectedPhoto, visiblePhotos]);

  const filmstripProgress = useMemo(() => {
    if (!selectedPhoto || visiblePhotos.length === 0) {
      return 0;
    }

    const index = visiblePhotos.findIndex((photo) => photo.path === selectedPhoto.path);
    return ((index + 1) / visiblePhotos.length) * 100;
  }, [selectedPhoto, visiblePhotos]);

  function applyState(state: FrontendState) {
    setGroups(state.groups);
    setPhotos(hydratePhotos(state.photos));
    setTagLibrary(state.tags);
    setLibraries(state.libraries);
  }

  async function refreshFromBackend() {
    const state = await invoke<FrontendState>("load_app_state");
    applyState(state);
  }

  async function handleImportDirectory() {
    try {
      setStatusMessage(TEXT.importing);
      const state = await invoke<FrontendState>("import_image_directory");
      applyState(state);
      const latestArtist = state.libraries[state.libraries.length - 1]?.photographerName ?? null;
      setExpandedArtist(latestArtist);
      setActiveGroupId("all");
      setStatusMessage("");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? TEXT.importError),
      );
    }
  }

  async function handleArchiveDrop(path: string) {
    if (!path.toLowerCase().endsWith(".zip")) {
      setStatusMessage(TEXT.unsupportedArchive);
      return;
    }

    try {
      setStatusMessage(TEXT.importing);
      const result = await invoke<ArchiveImportResult>("import_archive", {
        archivePath: path,
      });
      await refreshFromBackend();
      setExpandedArtist(result.photographerName);
      setActiveGroupId("all");
      setStatusMessage(
        result.createdNewPhotographer ? TEXT.importSuccessNew : TEXT.importSuccessMerge,
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? TEXT.importError),
      );
    }
  }

  function openCreateGroupDialog(photographerName: string) {
    setCreateGroupArtist(photographerName);
    setNewGroupName("");
  }

  function openCreateTagDialog() {
    setCreateTagOpen(true);
    setNewTagName("");
  }

  function closeCreateGroupDialog() {
    setCreateGroupArtist(null);
    setNewGroupName("");
  }

  function closeCreateTagDialog() {
    setCreateTagOpen(false);
    setNewTagName("");
  }

  function createGroup() {
    const name = newGroupName.trim();
    if (!name || !createGroupArtist) {
      return;
    }

    const nextGroup: StyleGroup = {
      id: `group-${Math.random().toString(36).slice(2, 10)}`,
      name,
      description: TEXT.groupDefaultDescription,
      photographerName: createGroupArtist,
    };

    setGroups((previous) => [...previous, nextGroup]);
    setExpandedArtist(createGroupArtist);
    setActiveGroupId(nextGroup.id);
    closeCreateGroupDialog();
  }

  function requestDeleteGroup(groupId: string, groupName: string) {
    setPendingDeleteTarget({ type: "group", id: groupId, name: groupName });
  }

  function requestDeleteTag(tagName: string) {
    if (!tagLibrary.includes(tagName)) {
      return;
    }

    setPendingDeleteTarget({ type: "tag", name: tagName });
  }

  function closeDeleteDialog() {
    setPendingDeleteTarget(null);
  }

  function confirmDelete() {
    if (!pendingDeleteTarget) {
      return;
    }

    if (pendingDeleteTarget.type === "group") {
      const groupId = pendingDeleteTarget.id;
      setGroups((previous) => previous.filter((group) => group.id !== groupId));
      setPhotos((previous) =>
        previous.map((photo) =>
          photo.groupId === groupId ? { ...photo, groupId: null } : photo,
        ),
      );
      if (activeGroupId === groupId) {
        setActiveGroupId("unassigned");
      }
    } else {
      const tagName = pendingDeleteTarget.name;
      setTagLibrary((previous) => previous.filter((tag) => tag !== tagName));
      setPhotos((previous) =>
        previous.map((photo) =>
          photo.tags.includes(tagName)
            ? { ...photo, tags: photo.tags.filter((tag) => tag !== tagName) }
            : photo,
        ),
      );
    }

    closeDeleteDialog();
  }

  function toggleTag(tag: string) {
    if (!selectedPhoto) {
      return;
    }

    setPhotos((previous) =>
      previous.map((photo) => {
        if (photo.path !== selectedPhoto.path) {
          return photo;
        }

        const hasTag = photo.tags.includes(tag);
        return {
          ...photo,
          tags: hasTag ? photo.tags.filter((item) => item !== tag) : [...photo.tags, tag],
        };
      }),
    );
  }

  function createTag() {
    const name = newTagName.trim();
    if (!name) {
      return;
    }

    setTagLibrary((previous) => {
      if (previous.includes(name)) {
        return previous;
      }
      return [...previous, name];
    });

    if (selectedPhoto) {
      setPhotos((previous) =>
        previous.map((photo) =>
          photo.path === selectedPhoto.path && !photo.tags.includes(name)
            ? { ...photo, tags: [...photo.tags, name] }
            : photo,
        ),
      );
    }

    closeCreateTagDialog();
  }

  function assignPhotoToGroup(groupId: string | null) {
    if (!selectedPhoto) {
      return;
    }

    setPhotos((previous) =>
      previous.map((photo) =>
        photo.path === selectedPhoto.path ? { ...photo, groupId } : photo,
      ),
    );
  }

  async function copyPaletteValue(tone: string) {
    const rgbValue = hexToRgb(tone);

    try {
      await navigator.clipboard.writeText(rgbValue);
      setCopiedPaletteValue(rgbValue);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? "复制失败"),
      );
    }
  }

  function updatePhotoSummary(value: string) {
    if (!selectedPhoto) {
      return;
    }

    setPhotos((previous) =>
      previous.map((photo) =>
        photo.path === selectedPhoto.path ? { ...photo, summary: value } : photo,
      ),
    );
  }

  function handleFilmstripWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const container = event.currentTarget;
    if (container.scrollWidth <= container.clientWidth) {
      return;
    }

    const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (delta === 0) {
      return;
    }

    event.preventDefault();
    container.scrollLeft += delta;
  }

  return (
    <div className={`studio-shell ${dragActive ? "drag-active" : ""}`}>
      <aside className="studio-sidebar">
        <div className="sidebar-brand">
          <div className="brand-icon">
            <Palette size={16} />
          </div>
          <span>{TEXT.appName}</span>
        </div>

        <div className="sidebar-search">
          <Search size={12} />
          <input
            value={searchArtist}
            onChange={(event) => setSearchArtist(event.currentTarget.value)}
            placeholder={TEXT.searchArtist}
          />
        </div>

        <nav className="artist-tree">
          {artistTree.length === 0 ? (
            <div className="sidebar-empty">
              <strong>{TEXT.noPhotographer}</strong>
              <p>{TEXT.noPhotographerHint}</p>
            </div>
          ) : (
            artistTree.map((artist) => {
              const expanded = expandedArtist === artist.photographerName;

              return (
                <div key={artist.directory} className="artist-node">
                  <button
                    className={`artist-button ${expanded ? "active" : ""}`}
                    onClick={() => setExpandedArtist(artist.photographerName)}
                    type="button"
                  >
                    <div className="artist-button-main">
                      {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      <span>{artist.photographerName}</span>
                    </div>
                    <span className="artist-count">{artist.count}</span>
                  </button>

                  {expanded ? (
                    <div className="group-tree">
                      {artist.groups.map((group) => (
                        <button
                          key={`${artist.photographerName}-${group.id}`}
                          className={`group-link ${activeGroupId === group.id ? "active" : ""}`}
                          onClick={() => {
                            setExpandedArtist(artist.photographerName);
                            setActiveGroupId(group.id);
                          }}
                          type="button"
                        >
                          <span>{group.name}</span>
                          <span className="group-link-meta">
                            <span>{group.count}</span>
                            {group.id !== "all" && group.id !== "unassigned" ? (
                              <span
                                className="group-delete-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  requestDeleteGroup(group.id, group.name);
                                }}
                                role="button"
                                tabIndex={0}
                                aria-label={TEXT.deleteGroup}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    requestDeleteGroup(group.id, group.name);
                                  }
                                }}
                              >
                                <Trash2 size={11} />
                              </span>
                            ) : null}
                          </span>
                        </button>
                      ))}

                      <button
                        className="group-link create-group-link"
                        onClick={() => openCreateGroupDialog(artist.photographerName)}
                        type="button"
                      >
                        <span>{TEXT.createGroup}</span>
                        <Plus size={12} />
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </nav>

        <div className="sidebar-bottom">
          <button className="import-button" onClick={handleImportDirectory} type="button">
            <Upload size={12} />
            <span>{TEXT.importAssets}</span>
          </button>
          <p className="import-hint">{TEXT.importHint}</p>
          <p className="import-hint">{dragActive ? TEXT.dropReady : TEXT.dropHint}</p>
          {statusMessage ? <p className="import-status">{statusMessage}</p> : null}
        </div>
      </aside>

      <main className="studio-main">
        <header className="main-header">
          <div className="header-breadcrumb">
            <span>{TEXT.library}</span>
            <ChevronRight size={10} />
            <span>{currentArtist ?? TEXT.artistNotSelected}</span>
            <ChevronRight size={10} />
            <span className="header-pill">{activeGroupName}</span>
          </div>

          <div className="header-actions">
            <button type="button" aria-label="筛选">
              <Filter size={15} />
            </button>
            <button type="button" aria-label="设置">
              <Settings size={15} />
            </button>
          </div>
        </header>

        <div className="main-body">
          <div className="workspace-grid">
            <section className="viewer-column">
              <div className="viewer-card">
                {selectedPhoto ? (
                  <>
                    <img
                      src={selectedPhoto.previewSrc}
                      alt={selectedPhoto.name}
                      className="viewer-image"
                    />
                  </>
                ) : (
                  <div className="viewer-empty">
                    <strong>{TEXT.chooseImage}</strong>
                    <p>{TEXT.chooseImageHint}</p>
                  </div>
                )}
              </div>

              <div className="viewer-toolbar">
                <div className="viewer-toolbar-spacer" />

                <div className="viewer-toolbar-right">
                  <div className="viewer-meta">
                    <span>
                      {imageMetrics
                        ? `${imageMetrics.width} x ${imageMetrics.height}`
                        : "-"}
                    </span>
                    <span>{imageMetrics ? formatAspectRatio(imageMetrics.width, imageMetrics.height) : "-"}</span>
                  </div>

                  <div className="viewer-tool-buttons">
                    <button type="button" aria-label="图片信息">
                      <Info size={14} />
                    </button>
                    <button type="button" aria-label="更多操作">
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <aside className="info-column">
              <section className="info-block">
                <h4>{TEXT.palette}</h4>
                {copiedPaletteValue ? (
                  <div className="palette-copy-status">
                    {`${TEXT.copiedValue} ${copiedPaletteValue}`}
                  </div>
                ) : null}
                <div className="palette-list">
                  {selectedPhoto ? (
                    buildPalette(selectedPhoto.palette).map((tone, index) => (
                      <button
                        key={`${selectedPhoto.path}-${tone}-${index}`}
                        className="palette-item"
                        onClick={() => void copyPaletteValue(tone)}
                        type="button"
                      >
                        <span
                          className="palette-swatch"
                          style={{ backgroundColor: tone }}
                        />
                        <div className="palette-text">
                          <span>{hexToRgb(tone)}</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="info-empty">{TEXT.emptyPalette}</div>
                  )}
                </div>
              </section>

              <section className="info-block">
                <h4>{TEXT.currentGroup}</h4>
                <div className="tag-list">
                  <button
                    className={`tag-chip ${selectedPhoto?.groupId === null ? "active" : ""}`}
                    onClick={() => assignPhotoToGroup(null)}
                    type="button"
                  >
                    {TEXT.ungrouped}
                  </button>
                  {currentArtistGroups.map((group) => (
                    <button
                      key={group.id}
                      className={`tag-chip ${
                        selectedPhoto?.groupId === group.id ? "active" : ""
                      }`}
                      onClick={() => assignPhotoToGroup(group.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        requestDeleteGroup(group.id, group.name);
                      }}
                      type="button"
                    >
                      {group.name}
                    </button>
                  ))}
                  <button
                    className="tag-plus"
                    type="button"
                    aria-label={TEXT.createGroup}
                    onClick={() => currentArtist && openCreateGroupDialog(currentArtist)}
                  >
                    <Plus size={10} />
                  </button>
                </div>
              </section>

              <section className="info-block">
                <h4>{TEXT.tags}</h4>
                <div className="tag-list">
                  {tagLibrary.map((tag) => (
                    <button
                      key={tag}
                      className={`tag-chip ${
                        selectedPhoto?.tags.includes(tag) ? "active" : ""
                      }`}
                      onClick={() => toggleTag(tag)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        requestDeleteTag(tag);
                      }}
                      type="button"
                    >
                      {tag}
                    </button>
                  ))}
                  <button
                    className="tag-plus"
                    type="button"
                    aria-label="添加标签"
                    onClick={openCreateTagDialog}
                  >
                    <Plus size={10} />
                  </button>
                </div>
              </section>

              <section className="info-block">
                <h4>{TEXT.summary}</h4>
                <textarea
                  className="summary-card summary-input"
                  value={selectedPhoto?.summary ?? ""}
                  onChange={(event) => updatePhotoSummary(event.currentTarget.value)}
                  rows={6}
                  disabled={!selectedPhoto}
                />
              </section>
            </aside>
          </div>

          <section className="filmstrip-section">
            <div className="filmstrip-header">
              <div className="filmstrip-title">
                <span>{TEXT.filmstrip}</span>
                <span>{filmstripPosition}</span>
              </div>

              <div className="filmstrip-progress">
                <div
                  className="filmstrip-progress-bar"
                  style={{ width: `${filmstripProgress}%` }}
                />
              </div>
            </div>

            {currentArtist ? (
              <div className="filmstrip-row" onWheel={handleFilmstripWheel}>
                {visiblePhotos.map((photo) => (
                  <button
                    key={photo.path}
                    className={`film-thumb ${selectedPhotoPath === photo.path ? "active" : ""}`}
                    onClick={() => setSelectedPhotoPath(photo.path)}
                    type="button"
                  >
                    <img src={photo.previewSrc} alt={photo.name} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="sidebar-empty">
                <strong>{TEXT.noPhotographer}</strong>
                <p>{TEXT.noPhotographerHint}</p>
              </div>
            )}
          </section>
        </div>
      </main>

      {createGroupArtist ? (
        <div className="modal-overlay" onClick={closeCreateGroupDialog} role="presentation">
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>{TEXT.createGroup}</h3>
            <p className="modal-subtitle">{createGroupArtist}</p>
            <input
              autoFocus
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  createGroup();
                }
                if (event.key === "Escape") {
                  closeCreateGroupDialog();
                }
              }}
              placeholder={TEXT.createGroupName}
            />
            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={closeCreateGroupDialog}>
                {TEXT.cancel}
              </button>
              <button type="button" className="modal-primary" onClick={createGroup}>
                {TEXT.createGroupAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {createTagOpen ? (
        <div className="modal-overlay" onClick={closeCreateTagDialog} role="presentation">
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>新建标签</h3>
            <p className="modal-subtitle">创建后会加入标签库</p>
            <input
              autoFocus
              value={newTagName}
              onChange={(event) => setNewTagName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  createTag();
                }
                if (event.key === "Escape") {
                  closeCreateTagDialog();
                }
              }}
              placeholder="例如：电影感"
            />
            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={closeCreateTagDialog}>
                取消
              </button>
              <button type="button" className="modal-primary" onClick={createTag}>
                创建标签
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDeleteTarget ? (
        <div className="modal-overlay" onClick={closeDeleteDialog} role="presentation">
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>{pendingDeleteTarget.type === "group" ? "删除分组" : "删除标签"}</h3>
            <p className="modal-subtitle">{pendingDeleteTarget.name}</p>
            <p className="modal-message">
              {pendingDeleteTarget.type === "group"
                ? "删除后，这个分组里的图片都会回到未分组。"
                : "删除后，所有图片都会移除这个标签。"}
            </p>
            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={closeDeleteDialog}>
                取消
              </button>
              <button type="button" className="modal-danger" onClick={confirmDelete}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
