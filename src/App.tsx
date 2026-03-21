import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Info,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  Pipette,
  RotateCcw,
  Search,
  Settings,
  Star,
  Trash2,
  Upload,
  Download,
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
  starred: boolean;
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
  originalName: string;
  directory: string;
};

type FrontendState = {
  groups: StyleGroup[];
  photos: PersistedPhoto[];
  tags: string[];
  archiveLogs: ArchiveLog[];
  libraries: LibraryEntry[];
  groupNotes: Record<string, string>;
  groupViewPositions: Record<string, number>;
};

type ArchiveImportResult = {
  photographerName: string;
  targetDir: string;
  extractedFiles: number;
  createdNewPhotographer: boolean;
};

type ExportGroupPhotosResult = {
  targetDir: string;
  exportedFiles: number;
};

type DedupeProgress = {
  processed: number;
  total: number;
  duplicatesFound: number;
  completed: boolean;
};

type DedupePhotosResult = {
  duplicatesFound: number;
  hiddenFiles: number;
  state: FrontendState;
};

type ArchiveImportPreview = {
  parsedPhotographerName: string;
  suggestedTargetName: string | null;
  libraries: LibraryEntry[];
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
      photographerName: string;
    }
  | {
      type: "tag";
      name: string;
    };

type ImageMetrics = {
  width: number;
  height: number;
};

type PickerPreview = {
  left: number;
  top: number;
  backgroundSize: string;
  backgroundPosition: string;
};

type WorkspaceView = "group" | "detail";

type ThumbnailScale = "small" | "medium" | "large" | "xlarge";

const DEFAULT_FALLBACK_PALETTE = [
  "#d9b08c",
  "#7d5a50",
  "#2f3e46",
  "#f2cc8f",
  "#81b29a",
  "#3d405b",
];

const TEXT = {
  appName: "影集",
  searchArtist: "搜索摄影师...",
  importAssets: "导入资源",
  importHint: "支持文件夹导入，也支持直接拖入 ZIP",
  library: "图片库",
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
  exportSuccess: "分组导出完成",
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
  paletteLoading: "色卡加载中...",
  paletteEmpty: "还没有提取到色卡",
  copiedValue: "已复制",
};

function normalizeSearchKeyword(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_\-.]+/g, "")
    .trim();
}

function hydratePhotos(photos: PersistedPhoto[]): PhotoItem[] {
  return photos.map((photo) => ({
    ...photo,
    previewSrc: convertFileSrc(photo.path),
  }));
}

function buildPalette(colors: string[]) {
  return Array.from(new Set(colors)).slice(0, 6);
}

function isFallbackPalette(colors: string[]) {
  const normalized = buildPalette(colors).map(normalizeHex);
  return (
    normalized.length === DEFAULT_FALLBACK_PALETTE.length &&
    normalized.every((color, index) => color === DEFAULT_FALLBACK_PALETTE[index])
  );
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

function normalizeHex(hex: string) {
  const raw = hex.trim().replace("#", "");
  const expanded =
    raw.length === 3
      ? raw
          .split("")
          .map((item) => `${item}${item}`)
          .join("")
      : raw;

  return `#${expanded.slice(0, 6).padEnd(6, "0").toLowerCase()}`;
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex).replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function colorDistance(
  left: [number, number, number],
  right: [number, number, number],
) {
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return Math.sqrt(red * red + green * green + blue * blue);
}

async function buildPaletteOverlay(
  imageSrc: string,
  tone: string,
): Promise<string | null> {
  const image = new Image();
  image.crossOrigin = "anonymous";

  const loaded = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = imageSrc;
  });

  if (!loaded) {
    return null;
  }

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }

  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const output = context.createImageData(width, height);
  const target = hexToRgbTuple(tone);
  let highlightedPixels = 0;

  for (let index = 0; index < imageData.data.length; index += 4) {
    const alpha = imageData.data[index + 3];
    if (alpha < 8) {
      continue;
    }

    const pixelIndex = index / 4;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const current: [number, number, number] = [
      imageData.data[index],
      imageData.data[index + 1],
      imageData.data[index + 2],
    ];
    const distance = colorDistance(current, target);
    if (distance > 68) {
      continue;
    }

    const closeness = 1 - distance / 68;
    const stripeHit = (x + y) % 14 < 7;
    output.data[index] = 255;
    output.data[index + 1] = stripeHit ? 64 : 0;
    output.data[index + 2] = stripeHit ? 64 : 0;
    output.data[index + 3] = Math.round((stripeHit ? 165 : 95) + closeness * 70);
    highlightedPixels += 1;
  }

  if (highlightedPixels === 0) {
    return null;
  }

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = width;
  overlayCanvas.height = height;
  const overlayContext = overlayCanvas.getContext("2d");
  if (!overlayContext) {
    return null;
  }

  overlayContext.putImageData(output, 0, 0);
  return overlayCanvas.toDataURL("image/png");
}

async function sampleImageColor(
  imageSrc: string,
  naturalWidth: number,
  naturalHeight: number,
  xRatio: number,
  yRatio: number,
): Promise<string | null> {
  const image = new Image();
  image.crossOrigin = "anonymous";

  const loaded = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = imageSrc;
  });

  if (!loaded) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }

  context.drawImage(image, 0, 0, naturalWidth, naturalHeight);
  const x = Math.max(0, Math.min(naturalWidth - 1, Math.floor(xRatio * naturalWidth)));
  const y = Math.max(0, Math.min(naturalHeight - 1, Math.floor(yRatio * naturalHeight)));
  const pixel = context.getImageData(x, y, 1, 1).data;
  return normalizeHex(
    `#${pixel[0].toString(16).padStart(2, "0")}${pixel[1]
      .toString(16)
      .padStart(2, "0")}${pixel[2].toString(16).padStart(2, "0")}`,
  );
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
  const keyword = normalizeSearchKeyword(searchArtist);

  return libraries
    .filter((library) => {
      if (!keyword) {
        return true;
      }

      return normalizeSearchKeyword(library.photographerName).includes(keyword);
    })
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

function buildGroupNoteKey(photographerName: string | null, groupId: string) {
  if (!photographerName) {
    return null;
  }

  return `${photographerName}::${groupId}`;
}

function App() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [groups, setGroups] = useState<StyleGroup[]>([]);
  const [tagLibrary, setTagLibrary] = useState<string[]>([]);
  const [libraries, setLibraries] = useState<LibraryEntry[]>([]);
  const [groupNotes, setGroupNotes] = useState<Record<string, string>>({});
  const [groupViewPositions, setGroupViewPositions] = useState<Record<string, number>>({});
  const [searchArtist, setSearchArtist] = useState("");
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null);
  const [expandedArtist, setExpandedArtist] = useState<string | null>(null);
  const [activeGroupId, setActiveGroupId] = useState("all");
  const [selectedPhotoPath, setSelectedPhotoPath] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("group");
  const [thumbnailScale, setThumbnailScale] = useState<ThumbnailScale>("medium");
  const [selectedGroupPhotoPaths, setSelectedGroupPhotoPaths] = useState<string[]>([]);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveTargetGroupId, setMoveTargetGroupId] = useState<string>("unassigned");
  const [moveNewGroupName, setMoveNewGroupName] = useState("");
  const [renameArtistTarget, setRenameArtistTarget] = useState<string | null>(null);
  const [renameArtistValue, setRenameArtistValue] = useState("");
  const [archiveImportPreview, setArchiveImportPreview] = useState<ArchiveImportPreview | null>(null);
  const [archiveImportPath, setArchiveImportPath] = useState<string | null>(null);
  const [archiveImportMode, setArchiveImportMode] = useState<"new" | "merge">("new");
  const [archiveImportTargetName, setArchiveImportTargetName] = useState<string>("");
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
  const [activePaletteTone, setActivePaletteTone] = useState<string | null>(null);
  const [paletteOverlaySrc, setPaletteOverlaySrc] = useState<string | null>(null);
  const [paletteLoadingPath, setPaletteLoadingPath] = useState<string | null>(null);
  const [paletteEditorOpen, setPaletteEditorOpen] = useState(false);
  const [paletteDraft, setPaletteDraft] = useState<string[]>([]);
  const [paletteEditIndex, setPaletteEditIndex] = useState<number | null>(null);
  const [pickingPaletteIndex, setPickingPaletteIndex] = useState<number | null>(null);
  const [paletteHint, setPaletteHint] = useState<string | null>(null);
  const [pickerPreview, setPickerPreview] = useState<PickerPreview | null>(null);
  const [dedupeProgress, setDedupeProgress] = useState<DedupeProgress | null>(null);
  const [dedupeRunning, setDedupeRunning] = useState(false);
  const [restorePrompt, setRestorePrompt] = useState<{
    viewKey: string;
    scrollTop: number;
  } | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const viewerCardRef = useRef<HTMLDivElement | null>(null);
  const mainBodyRef = useRef<HTMLDivElement | null>(null);
  const paletteHydrationRef = useRef<Set<string>>(new Set());
  const groupScrollTopRef = useRef(0);
  const restorePromptTimerRef = useRef<number | null>(null);
  const pendingScrollSaveTimerRef = useRef<number | null>(null);

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
    let cleanup: (() => void) | undefined;

    void listen<DedupeProgress>("dedupe-progress", (event) => {
      setDedupeProgress(event.payload);
      if (event.payload.completed) {
        window.setTimeout(() => {
          setDedupeProgress((current) => (current?.completed ? null : current));
        }, 1800);
      }
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const payload = {
      groups,
      groupNotes,
      tags: tagLibrary,
      photos: photos.map<PersistedPhoto>(({ previewSrc: _previewSrc, ...photo }) => photo),
    };

    void invoke("save_app_state", { payload }).catch((error) => {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? TEXT.saveError),
      );
    });
  }, [groupNotes, groups, hydrated, photos, tagLibrary]);

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
      setSelectedArtist(null);
      setExpandedArtist(null);
      return;
    }

    if (
      !selectedArtist ||
      !artistTree.some((artist) => artist.photographerName === selectedArtist)
    ) {
      setSelectedArtist(artistTree[0].photographerName);
    }

    if (
      expandedArtist &&
      !artistTree.some((artist) => artist.photographerName === expandedArtist)
    ) {
      setExpandedArtist(null);
    }
  }, [artistTree, expandedArtist, selectedArtist]);

  const currentArtist = selectedArtist;

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

    return photos
      .filter((photo) => photo.photographerName === currentArtist)
      .map((photo, index) => ({ photo, index }))
      .sort((left, right) => {
        if (left.photo.starred !== right.photo.starred) {
          return left.photo.starred ? -1 : 1;
        }
        return left.index - right.index;
      })
      .map(({ photo }) => photo);
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
      setWorkspaceView("group");
      return;
    }

    if (!selectedPhotoPath || !visiblePhotos.some((photo) => photo.path === selectedPhotoPath)) {
      setSelectedPhotoPath(visiblePhotos[0].path);
    }
  }, [selectedPhotoPath, visiblePhotos]);

  useEffect(() => {
    setSelectedGroupPhotoPaths([]);
    setMoveDialogOpen(false);
    setMoveNewGroupName("");
    setMoveTargetGroupId("unassigned");
  }, [activeGroupId, currentArtist]);

  useEffect(() => {
    return () => {
      if (restorePromptTimerRef.current !== null) {
        window.clearTimeout(restorePromptTimerRef.current);
      }
      if (pendingScrollSaveTimerRef.current !== null) {
        window.clearTimeout(pendingScrollSaveTimerRef.current);
      }
    };
  }, []);

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

  useEffect(() => {
    setActivePaletteTone(null);
    setPaletteOverlaySrc(null);
    setPickingPaletteIndex(null);
    setPickerPreview(null);
    setPickerPreview(null);
    setPaletteHint(null);
    setPickerPreview(null);
  }, [selectedPhotoPath]);

  useEffect(() => {
    let active = true;

    if (!selectedPhoto || !activePaletteTone) {
      setPaletteOverlaySrc(null);
      setPickerPreview(null);
      setPickerPreview(null);
      return;
    }

    void buildPaletteOverlay(selectedPhoto.previewSrc, activePaletteTone).then((overlay) => {
      if (!active) {
        return;
      }

      setPaletteOverlaySrc(overlay);
    });

    return () => {
      active = false;
    };
  }, [activePaletteTone, selectedPhoto]);

  useEffect(() => {
    if (pickingPaletteIndex === null) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelPalettePicking();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pickingPaletteIndex]);

  useEffect(() => {
    if (workspaceView !== "detail" || visiblePhotos.length === 0 || !selectedPhotoPath) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "textarea") {
        return;
      }

      const currentIndex = visiblePhotos.findIndex((photo) => photo.path === selectedPhotoPath);
      if (currentIndex < 0) {
        return;
      }

      event.preventDefault();
      const nextIndex =
        event.key === "ArrowRight"
          ? Math.min(visiblePhotos.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);

      setSelectedPhotoPath(visiblePhotos[nextIndex]?.path ?? selectedPhotoPath);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedPhotoPath, visiblePhotos, workspaceView]);

  useEffect(() => {
    if (workspaceView !== "detail" || !selectedPhoto) {
      return;
    }

    const currentPalette = buildPalette(selectedPhoto.palette);
    if (currentPalette.length > 0 && !isFallbackPalette(currentPalette)) {
      return;
    }

    if (paletteHydrationRef.current.has(selectedPhoto.path)) {
      return;
    }

    paletteHydrationRef.current.add(selectedPhoto.path);
    setPaletteLoadingPath(selectedPhoto.path);

    void invoke<string[]>("extract_photo_palette", {
      photoPath: selectedPhoto.path,
    })
      .then((extracted) => {
        const nextPalette = buildPalette(extracted);
        setPhotos((previous) =>
          previous.map((photo) =>
            photo.path === selectedPhoto.path ? { ...photo, palette: nextPalette } : photo,
          ),
        );
        if (selectedPhotoPath === selectedPhoto.path) {
          setPaletteDraft(nextPalette);
        }
      })
      .catch(() => {
        paletteHydrationRef.current.delete(selectedPhoto.path);
      })
      .finally(() => {
        setPaletteLoadingPath((previous) =>
          previous === selectedPhoto.path ? null : previous,
        );
      });
  }, [selectedPhoto, selectedPhotoPath, workspaceView]);

  const activeGroupName = useMemo(() => {
    if (activeGroupId === "all") {
      return TEXT.allImages;
    }

    if (activeGroupId === "unassigned") {
      return TEXT.ungrouped;
    }

    return currentArtistGroups.find((group) => group.id === activeGroupId)?.name ?? TEXT.allImages;
  }, [activeGroupId, currentArtistGroups]);

  const currentGroupNoteKey = useMemo(
    () => buildGroupNoteKey(currentArtist, activeGroupId),
    [activeGroupId, currentArtist],
  );
  const currentGroupViewKey = currentGroupNoteKey;

  const currentGroupNote = useMemo(() => {
    if (!currentGroupNoteKey) {
      return "";
    }

    return groupNotes[currentGroupNoteKey] ?? "";
  }, [currentGroupNoteKey, groupNotes]);

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

  const showGroupWorkspace = workspaceView === "group";
  const selectedPhotoPalette = selectedPhoto ? buildPalette(selectedPhoto.palette) : [];

  useEffect(() => {
    if (restorePromptTimerRef.current !== null) {
      window.clearTimeout(restorePromptTimerRef.current);
      restorePromptTimerRef.current = null;
    }

    if (!showGroupWorkspace || !currentGroupViewKey) {
      setRestorePrompt(null);
      return;
    }

    const savedScrollTop = groupViewPositions[currentGroupViewKey] ?? 0;
    groupScrollTopRef.current = 0;
    if (mainBodyRef.current) {
      mainBodyRef.current.scrollTop = 0;
    }

    if (savedScrollTop <= 0) {
      setRestorePrompt(null);
      return;
    }

    setRestorePrompt({
      viewKey: currentGroupViewKey,
      scrollTop: savedScrollTop,
    });

    restorePromptTimerRef.current = window.setTimeout(() => {
      setRestorePrompt((previous) =>
        previous?.viewKey === currentGroupViewKey ? null : previous,
      );
      restorePromptTimerRef.current = null;
    }, 5000);

    return () => {
      if (restorePromptTimerRef.current !== null) {
        window.clearTimeout(restorePromptTimerRef.current);
        restorePromptTimerRef.current = null;
      }
    };
  }, [currentGroupViewKey, showGroupWorkspace]);

  useEffect(() => {
    if (!showGroupWorkspace || !currentGroupViewKey) {
      return;
    }

    return () => {
      if (pendingScrollSaveTimerRef.current !== null) {
        window.clearTimeout(pendingScrollSaveTimerRef.current);
        pendingScrollSaveTimerRef.current = null;
      }

      const savedScrollTop = Math.round(groupScrollTopRef.current);
      if (savedScrollTop > 0) {
        void persistGroupViewPosition(currentGroupViewKey, savedScrollTop);
      }
    };
  }, [currentGroupViewKey, showGroupWorkspace]);

  function applyState(state: FrontendState) {
    setGroups(state.groups);
    setPhotos(hydratePhotos(state.photos));
    setTagLibrary(state.tags);
    setLibraries(state.libraries);
    setGroupNotes(state.groupNotes ?? {});
    setGroupViewPositions(state.groupViewPositions ?? {});
  }

  async function refreshFromBackend() {
    const state = await invoke<FrontendState>("load_app_state");
    applyState(state);
  }

  async function persistGroupViewPosition(viewKey: string, scrollTop: number) {
    const normalizedScrollTop = Math.max(0, Math.round(scrollTop));
    setGroupViewPositions((previous) => {
      if (previous[viewKey] === normalizedScrollTop) {
        return previous;
      }

      return {
        ...previous,
        [viewKey]: normalizedScrollTop,
      };
    });

    try {
      await invoke("save_group_view_position", {
        viewKey,
        scrollTop: normalizedScrollTop,
      });
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? "保存浏览位置失败"),
      );
    }
  }

  async function handleImportDirectory() {
    try {
      setStatusMessage(TEXT.importing);
      const state = await invoke<FrontendState>("import_image_directory");
        applyState(state);
        const latestArtist = state.libraries[state.libraries.length - 1]?.photographerName ?? null;
        setSelectedArtist(latestArtist);
        setExpandedArtist(latestArtist);
        setActiveGroupId("all");
        setWorkspaceView("group");
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
      const preview = await invoke<ArchiveImportPreview>("preview_archive_import", {
        archivePath: path,
      });
      setArchiveImportPreview(preview);
      setArchiveImportPath(path);
      setArchiveImportMode(preview.suggestedTargetName ? "merge" : "new");
      setArchiveImportTargetName(
        preview.suggestedTargetName ?? preview.libraries[0]?.photographerName ?? "",
      );
      setStatusMessage("");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? TEXT.importError),
      );
    }
  }

  async function handleExportGroup() {
    if (visiblePhotos.length === 0) {
      return;
    }

    try {
      setStatusMessage("正在导出分组图片...");
      const result = await invoke<ExportGroupPhotosResult>("export_group_photos", {
        photoPaths: visiblePhotos.map((photo) => photo.path),
        groupName: activeGroupName,
      });
      setStatusMessage(
        `${TEXT.exportSuccess}：${result.exportedFiles} 张 -> ${result.targetDir}`,
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? "导出分组失败"),
      );
    }
  }

  async function handleDedupeCurrentGroup() {
    if (visiblePhotos.length < 2 || dedupeRunning) {
      return;
    }

    try {
      setDedupeRunning(true);
      setDedupeProgress({
        processed: 0,
        total: visiblePhotos.length,
        duplicatesFound: 0,
        completed: false,
      });

      const result = await invoke<DedupePhotosResult>("dedupe_photos_by_content", {
        photoPaths: visiblePhotos.map((photo) => photo.path),
      });

      applyState(result.state);
      setSelectedGroupPhotoPaths([]);
      setStatusMessage(
        result.hiddenFiles > 0
          ? `一键去重完成，已隐藏 ${result.hiddenFiles} 张重复图片`
          : "一键去重完成，没有发现重复图片",
      );
    } catch (error) {
      setDedupeProgress(null);
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? "一键去重失败"),
      );
    } finally {
      setDedupeRunning(false);
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
    setSelectedArtist(createGroupArtist);
    setExpandedArtist(createGroupArtist);
    setActiveGroupId(nextGroup.id);
    setWorkspaceView("group");
    closeCreateGroupDialog();
  }

  function requestDeleteGroup(groupId: string, groupName: string, photographerName: string) {
    setPendingDeleteTarget({
      type: "group",
      id: groupId,
      name: groupName,
      photographerName,
    });
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
      const noteKey = buildGroupNoteKey(pendingDeleteTarget.photographerName, groupId);
      if (noteKey) {
        setGroupNotes((previous) => {
          const next = { ...previous };
          delete next[noteKey];
          return next;
        });
        setGroupViewPositions((previous) => {
          const next = { ...previous };
          delete next[noteKey];
          return next;
        });
        void invoke("delete_group_view_position", {
          viewKey: noteKey,
        }).catch((error) => {
          setStatusMessage(
            error instanceof Error ? error.message : String(error ?? "删除浏览位置失败"),
          );
        });
      }
      setPhotos((previous) =>
        previous.map((photo) =>
          photo.groupId === groupId ? { ...photo, groupId: null } : photo,
        ),
      );
      if (activeGroupId === groupId) {
        setActiveGroupId("unassigned");
        setWorkspaceView("group");
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

  function togglePhotoStar(path: string) {
    setPhotos((previous) =>
      previous.map((photo) =>
        photo.path === path ? { ...photo, starred: !photo.starred } : photo,
      ),
    );
  }

  function updateGroupNote(value: string) {
    if (!currentGroupNoteKey) {
      return;
    }

    setGroupNotes((previous) => ({
      ...previous,
      [currentGroupNoteKey]: value,
    }));
  }

  function toggleGroupPhotoSelection(path: string) {
    setSelectedGroupPhotoPaths((previous) =>
      previous.includes(path)
        ? previous.filter((item) => item !== path)
        : [...previous, path],
    );
  }

  function openMoveDialog() {
    if (selectedGroupPhotoPaths.length === 0) {
      return;
    }

    setMoveTargetGroupId(currentArtistGroups[0]?.id ?? "unassigned");
    setMoveNewGroupName("");
    setMoveDialogOpen(true);
  }

  function openRenameArtistDialog(photographerName: string) {
    setRenameArtistTarget(photographerName);
    setRenameArtistValue(photographerName);
  }

  function closeRenameArtistDialog() {
    setRenameArtistTarget(null);
    setRenameArtistValue("");
  }

  async function confirmRenameArtist() {
    if (!renameArtistTarget) {
      return;
    }

    try {
      const state = await invoke<FrontendState>("rename_photographer", {
        oldName: renameArtistTarget,
        newName: renameArtistValue,
      });
      applyState(state);
      if (selectedArtist === renameArtistTarget) {
        const nextName = renameArtistValue.trim();
        setSelectedArtist(nextName);
        setExpandedArtist(nextName);
      }
      closeRenameArtistDialog();
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? "重命名摄影师失败"),
      );
    }
  }

  function closeArchiveImportDialog() {
    setArchiveImportPreview(null);
    setArchiveImportPath(null);
    setArchiveImportMode("new");
    setArchiveImportTargetName("");
  }

  async function confirmArchiveImport() {
    if (!archiveImportPath) {
      return;
    }

    try {
      setStatusMessage(TEXT.importing);
      const result = await invoke<ArchiveImportResult>("import_archive", {
        archivePath: archiveImportPath,
        createNew: archiveImportMode === "new",
        targetPhotographerName: archiveImportMode === "merge" ? archiveImportTargetName : null,
      });
      await refreshFromBackend();
      setSelectedArtist(result.photographerName);
      setExpandedArtist(result.photographerName);
      setActiveGroupId("all");
      setWorkspaceView("group");
      setStatusMessage(
        result.createdNewPhotographer ? TEXT.importSuccessNew : TEXT.importSuccessMerge,
      );
      closeArchiveImportDialog();
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? TEXT.importError),
      );
    }
  }

  function closeMoveDialog() {
    setMoveDialogOpen(false);
    setMoveNewGroupName("");
  }

  function applyMoveToGroup(targetGroupId: string | null) {
    if (selectedGroupPhotoPaths.length === 0) {
      closeMoveDialog();
      return;
    }

    const selectedSet = new Set(selectedGroupPhotoPaths);
    setPhotos((previous) =>
      previous.map((photo) =>
        selectedSet.has(photo.path) ? { ...photo, groupId: targetGroupId } : photo,
      ),
    );
    setSelectedGroupPhotoPaths([]);
    closeMoveDialog();
  }

  function confirmMovePhotos() {
    const newGroupName = moveNewGroupName.trim();
    if (newGroupName && currentArtist) {
      const nextGroup: StyleGroup = {
        id: `group-${Math.random().toString(36).slice(2, 10)}`,
        name: newGroupName,
        description: TEXT.groupDefaultDescription,
        photographerName: currentArtist,
      };

      setGroups((previous) => [...previous, nextGroup]);
      applyMoveToGroup(nextGroup.id);
      return;
    }

    applyMoveToGroup(moveTargetGroupId === "unassigned" ? null : moveTargetGroupId);
  }

  function openPaletteEditor() {
    if (!selectedPhoto) {
      return;
    }

    setPaletteDraft(buildPalette(selectedPhoto.palette));
    setPaletteEditorOpen(true);
  }

  function closePaletteEditor() {
    setPaletteEditorOpen(false);
    setPaletteDraft([]);
    setPaletteEditIndex(null);
    setPickingPaletteIndex(null);
    setPaletteHint(null);
    setPickerPreview(null);
  }

  async function savePaletteEditor() {
    if (!selectedPhoto) {
      closePaletteEditor();
      return;
    }

    const nextPalette = paletteDraft.map(normalizeHex).slice(0, 6);
    const nextPhotos = photos.map((photo) =>
      photo.path === selectedPhoto.path ? { ...photo, palette: nextPalette } : photo,
    );
    setPhotos(nextPhotos);

    if (activePaletteTone && !nextPalette.includes(activePaletteTone)) {
      setActivePaletteTone(null);
      setPaletteOverlaySrc(null);
      setPickerPreview(null);
    }

    try {
      await invoke("save_app_state", {
        payload: {
          groups,
          groupNotes,
          tags: tagLibrary,
          photos: nextPhotos.map(({ previewSrc: _previewSrc, ...photo }) => photo),
        },
      });
      setStatusMessage("");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? TEXT.saveError),
      );
    }

    closePaletteEditor();
  }

  function addPaletteTone() {
    setPaletteDraft((previous) =>
      previous.length >= 6 ? previous : [...previous, "#c8c8d8"],
    );
  }

  function removePaletteTone(index: number) {
    setPaletteDraft((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
  }

  function updatePaletteTone(index: number, value: string) {
    const normalized = normalizeHex(value);
    setPaletteDraft((previous) =>
      previous.map((tone, itemIndex) => (itemIndex === index ? normalized : tone)),
    );
  }

  function openNativeColorPicker(index: number) {
    setPaletteEditIndex(index);
    colorInputRef.current?.click();
  }

  async function resetPaletteToExtracted() {
    if (!selectedPhoto) {
      return;
    }

    try {
      const extracted = await invoke<string[]>("extract_photo_palette", {
        photoPath: selectedPhoto.path,
      });
      const nextPalette = buildPalette(extracted);
      setPhotos((previous) =>
        previous.map((photo) =>
          photo.path === selectedPhoto.path ? { ...photo, palette: nextPalette } : photo,
        ),
      );
      setPaletteDraft(nextPalette);
      setActivePaletteTone(null);
      setPaletteOverlaySrc(null);
      setPickerPreview(null);
      setPaletteHint("已恢复为程序自动提取的色卡。");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : String(error ?? "复原色卡失败"),
      );
    }
  }

  function beginPalettePicking(index: number) {
    setPickingPaletteIndex(index);
    setActivePaletteTone(null);
    setPaletteOverlaySrc(null);
    setPickerPreview(null);
    setPaletteHint("吸管模式已开启：点击主图取色，右键或 Esc 取消。");
  }

  function cancelPalettePicking() {
    setPickingPaletteIndex(null);
    setPickerPreview(null);
    setPaletteHint("已取消吸管取色。");
  }

  async function handlePaletteClick(tone: string) {
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

  function handlePaletteHover(tone: string | null) {
    if (pickingPaletteIndex !== null) {
      return;
    }

    setActivePaletteTone(tone);
  }

  function getViewerImageBounds(): {
    rect: DOMRect;
    renderedWidth: number;
    renderedHeight: number;
    offsetX: number;
    offsetY: number;
  } | null {
    if (!imageMetrics || !viewerCardRef.current) {
      return null;
    }

    const rect = viewerCardRef.current.getBoundingClientRect();
    const scale = Math.min(rect.width / imageMetrics.width, rect.height / imageMetrics.height);
    const renderedWidth = imageMetrics.width * scale;
    const renderedHeight = imageMetrics.height * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;

    return {
      rect,
      renderedWidth,
      renderedHeight,
      offsetX,
      offsetY,
    };
  }

  function handleViewerPickMove(event: React.MouseEvent<HTMLDivElement>) {
    if (pickingPaletteIndex === null || !selectedPhoto) {
      return;
    }

    const bounds = getViewerImageBounds();
    if (!bounds) {
      return;
    }

    const { rect, renderedWidth, renderedHeight, offsetX, offsetY } = bounds;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (
      x < offsetX ||
      x > offsetX + renderedWidth ||
      y < offsetY ||
      y > offsetY + renderedHeight
    ) {
      setPickerPreview(null);
      return;
    }

    const zoom = 3;
    const lensSize = 124;
    const imageX = x - offsetX;
    const imageY = y - offsetY;

    setPickerPreview({
      left: Math.min(rect.width - lensSize - 12, Math.max(12, x + 18)),
      top: Math.min(rect.height - lensSize - 12, Math.max(12, y - lensSize - 18)),
      backgroundSize: `${renderedWidth * zoom}px ${renderedHeight * zoom}px`,
      backgroundPosition: `-${imageX * zoom - lensSize / 2}px -${imageY * zoom - lensSize / 2}px`,
    });
  }

  function handleViewerPickLeave() {
    if (pickingPaletteIndex === null) {
      return;
    }

    setPickerPreview(null);
  }

  async function handleViewerPick(event: React.MouseEvent<HTMLDivElement>) {
    if (
      pickingPaletteIndex === null ||
      !selectedPhoto ||
      !imageMetrics ||
      !viewerCardRef.current
    ) {
      return;
    }

    const rect = viewerCardRef.current.getBoundingClientRect();
    const scale = Math.min(rect.width / imageMetrics.width, rect.height / imageMetrics.height);
    const renderedWidth = imageMetrics.width * scale;
    const renderedHeight = imageMetrics.height * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (
      x < offsetX ||
      x > offsetX + renderedWidth ||
      y < offsetY ||
      y > offsetY + renderedHeight
    ) {
      return;
    }

    const xRatio = (x - offsetX) / renderedWidth;
    const yRatio = (y - offsetY) / renderedHeight;
    const sampled = await sampleImageColor(
      selectedPhoto.previewSrc,
      imageMetrics.width,
      imageMetrics.height,
      xRatio,
      yRatio,
    );

    if (!sampled) {
      setPaletteHint("取色失败，请换个位置再试。");
      return;
    }

    updatePaletteTone(pickingPaletteIndex, sampled);
    setPickingPaletteIndex(null);
    setPickerPreview(null);
    setPaletteHint(`已取样 ${hexToRgb(sampled)}。`);
  }

  function handleViewerPickCancel(event: React.MouseEvent<HTMLDivElement>) {
    if (pickingPaletteIndex === null) {
      return;
    }

    event.preventDefault();
    cancelPalettePicking();
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

  function handleMainBodyScroll(event: ReactUIEvent<HTMLDivElement>) {
    if (!showGroupWorkspace || !currentGroupViewKey) {
      return;
    }

    const nextScrollTop = event.currentTarget.scrollTop;
    groupScrollTopRef.current = nextScrollTop;

    if (restorePrompt) {
      setRestorePrompt(null);
    }

    if (pendingScrollSaveTimerRef.current !== null) {
      window.clearTimeout(pendingScrollSaveTimerRef.current);
    }

    pendingScrollSaveTimerRef.current = window.setTimeout(() => {
      void persistGroupViewPosition(currentGroupViewKey, nextScrollTop);
      pendingScrollSaveTimerRef.current = null;
    }, 480);
  }

  function continueFromSavedGroupPosition() {
    if (!restorePrompt || !mainBodyRef.current) {
      return;
    }

    mainBodyRef.current.scrollTo({
      top: restorePrompt.scrollTop,
      behavior: "smooth",
    });
    groupScrollTopRef.current = restorePrompt.scrollTop;
    setRestorePrompt(null);
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
                  <div
                    className={`artist-button ${expanded ? "active" : ""}`}
                    onClick={(event) => {
                      if (
                        event.target instanceof HTMLElement &&
                        event.target.closest(".artist-toggle")
                      ) {
                        return;
                      }

                       setSelectedArtist(artist.photographerName);
                       setExpandedArtist(artist.photographerName);
                       setWorkspaceView("group");
                     }}
                  >
                    <div className="artist-button-main">
                      <span
                        className="artist-toggle"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setExpandedArtist((previous) =>
                            previous === artist.photographerName ? null : artist.photographerName,
                          );
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={expanded ? "收起摄影师分组" : "展开摄影师分组"}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            setExpandedArtist((previous) =>
                              previous === artist.photographerName ? null : artist.photographerName,
                            );
                          }
                        }}
                      >
                        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      </span>
                      <span
                        className="artist-name"
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openRenameArtistDialog(artist.photographerName);
                        }}
                      >
                        {artist.photographerName}
                      </span>
                    </div>
                    <span className="artist-count">{artist.count}</span>
                  </div>

                  {expanded ? (
                    <div className="group-tree">
                      {artist.groups.map((group) => (
                        <button
                          key={`${artist.photographerName}-${group.id}`}
                          className={`group-link ${activeGroupId === group.id ? "active" : ""}`}
                          onClick={() => {
                           setSelectedArtist(artist.photographerName);
                           setExpandedArtist(artist.photographerName);
                           setActiveGroupId(group.id);
                           setWorkspaceView("group");
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
                                  requestDeleteGroup(
                                    group.id,
                                    group.name,
                                    artist.photographerName,
                                  );
                                }}
                                role="button"
                                tabIndex={0}
                                aria-label={TEXT.deleteGroup}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    requestDeleteGroup(
                                      group.id,
                                      group.name,
                                      artist.photographerName,
                                    );
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
            <button
              type="button"
              className="breadcrumb-link"
              onClick={() => setWorkspaceView("group")}
            >
              {currentArtist ?? TEXT.artistNotSelected}
            </button>
            <ChevronRight size={10} />
            <button
              type="button"
              className="header-pill breadcrumb-pill-button"
              onClick={() => setWorkspaceView("group")}
            >
              {activeGroupName}
            </button>
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

        <div
          className="main-body"
          ref={mainBodyRef}
          onScroll={handleMainBodyScroll}
        >
          {false && showGroupWorkspace && restorePrompt ? (
            <div className="group-restore-toast" role="status" aria-live="polite">
              <span>是否从上次浏览位置继续观看？</span>
              <div className="group-restore-toast-actions">
                <button type="button" onClick={() => setRestorePrompt(null)}>
                  先不用
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={continueFromSavedGroupPosition}
                >
                  继续观看
                </button>
              </div>
            </div>
          ) : null}

          <div className="workspace-grid">
            {showGroupWorkspace ? (
              <section className="group-browser-column">
                <div className="group-browser-header">
                  <div className="group-browser-title">
                    <strong>{activeGroupName}</strong>
                    <span>{visiblePhotos.length} 张图片</span>
                  </div>
                  <div className="group-browser-actions">
                    <button
                      type="button"
                      className="move-group-button"
                      onClick={() => void handleDedupeCurrentGroup()}
                      disabled={visiblePhotos.length < 2 || dedupeRunning}
                    >
                      {dedupeRunning ? "正在去重..." : "一键去重"}
                    </button>
                    <button
                      type="button"
                      className="move-group-button export-group-button"
                      onClick={() => void handleExportGroup()}
                      disabled={visiblePhotos.length === 0}
                    >
                      <Download size={14} />
                      导出分组
                    </button>
                    {selectedGroupPhotoPaths.length > 0 ? (
                      <button
                        type="button"
                        className="move-group-button"
                        onClick={openMoveDialog}
                      >
                        移动到...
                      </button>
                    ) : null}
                    <div className="thumbnail-size-toggle">
                    {([
                      ["small", "小"],
                      ["medium", "中"],
                      ["large", "大"],
                      ["xlarge", "超大"],
                    ] as const).map(([size, label]) => (
                      <button
                        key={size}
                        type="button"
                        className={thumbnailScale === size ? "active" : ""}
                        onClick={() => setThumbnailScale(size)}
                      >
                        {label}
                      </button>
                    ))}
                    </div>
                  </div>
                </div>

                {dedupeProgress ? (
                  <div className="dedupe-progress">
                    <div className="dedupe-progress-meta">
                      <span>{dedupeRunning ? "正在按图片内容去重..." : "去重完成"}</span>
                      <span>
                        {dedupeProgress.processed} / {dedupeProgress.total} · 重复 {dedupeProgress.duplicatesFound}
                      </span>
                    </div>
                    <div className="dedupe-progress-track">
                      <div
                        className="dedupe-progress-bar"
                        style={{
                          width: `${Math.round((dedupeProgress.processed / Math.max(dedupeProgress.total, 1)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : null}

                {visiblePhotos.length > 0 ? (
                  <div className={`group-browser-grid ${thumbnailScale}`}>
                    {visiblePhotos.map((photo) => (
                      <button
                        key={photo.path}
                        type="button"
                        className={`group-browser-thumb ${
                          selectedGroupPhotoPaths.includes(photo.path) ? "selected" : ""
                        }`}
                        onClick={() => toggleGroupPhotoSelection(photo.path)}
                        onDoubleClick={() => {
                          setSelectedPhotoPath(photo.path);
                          setWorkspaceView("detail");
                        }}
                      >
                        <button
                          type="button"
                          className={`photo-star-button ${photo.starred ? "active" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            togglePhotoStar(photo.path);
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                          aria-label={photo.starred ? "取消星标" : "标记星标"}
                        >
                          <Star size={14} fill={photo.starred ? "currentColor" : "none"} />
                        </button>
                        <span
                          className={`group-browser-check ${
                            selectedGroupPhotoPaths.length > 0 ? "visible" : ""
                          } ${
                            selectedGroupPhotoPaths.includes(photo.path) ? "checked" : ""
                          }`}
                        />
                        <img src={photo.previewSrc} alt={photo.name} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="group-browser-empty">
                    <strong>这个分组里还没有图片</strong>
                    <p>先整理图片到这个分组，或者切换到其他分组看看。</p>
                  </div>
                )}
              </section>
            ) : (
            <section className="viewer-column">
              <div
                className={`viewer-card ${pickingPaletteIndex !== null ? "picking" : ""}`}
                ref={viewerCardRef}
                onClick={handleViewerPick}
                onMouseMove={handleViewerPickMove}
                onMouseLeave={handleViewerPickLeave}
                onContextMenu={handleViewerPickCancel}
              >
                {selectedPhoto ? (
                  <>
                    <img
                      src={selectedPhoto.previewSrc}
                      alt={selectedPhoto.name}
                      className="viewer-image"
                    />
                    {paletteOverlaySrc ? (
                      <img
                        src={paletteOverlaySrc}
                        alt=""
                        className="viewer-image viewer-overlay"
                      />
                    ) : null}
                    {pickingPaletteIndex !== null ? (
                      <>
                        <div className="viewer-interaction-layer" />
                        {pickerPreview ? (
                          <div
                            className="viewer-pick-lens"
                            style={{
                              left: pickerPreview.left,
                              top: pickerPreview.top,
                              backgroundImage: `url(${selectedPhoto.previewSrc})`,
                              backgroundSize: pickerPreview.backgroundSize,
                              backgroundPosition: pickerPreview.backgroundPosition,
                            }}
                          >
                            <span className="viewer-pick-lens-center" />
                          </div>
                        ) : null}
                        <div className="viewer-pick-hint">吸管模式：点击主图取色，右键或 Esc 取消</div>
                      </>
                    ) : null}
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
                    <button
                      type="button"
                      className={`viewer-star-button ${selectedPhoto?.starred ? "active" : ""}`}
                      onClick={() => selectedPhoto && togglePhotoStar(selectedPhoto.path)}
                      aria-label={selectedPhoto?.starred ? "取消星标" : "标记星标"}
                    >
                      <Star size={14} fill={selectedPhoto?.starred ? "currentColor" : "none"} />
                    </button>
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
            )}

            <aside className={`info-column ${showGroupWorkspace ? "group-note-column" : ""}`}>
              {showGroupWorkspace ? (
                <section className="info-block">
                  <div className="info-block-header">
                    <h4>NOTEBOOK</h4>
                  </div>
                  <textarea
                    className="summary-card summary-input group-note-input"
                    value={currentGroupNote}
                    onChange={(event) => updateGroupNote(event.currentTarget.value)}
                    rows={14}
                    disabled={!currentArtist}
                    placeholder="在这里记录这个分组的风格、用光、颜色、构图或者你想记住的关键词。"
                  />
                </section>
              ) : (
                <>
              <section className="info-block">
                <div className="info-block-header">
                  <h4>{TEXT.palette}</h4>
                  <div className="palette-header-actions">
                    <button
                      className="info-block-edit"
                      type="button"
                      onClick={() => void resetPaletteToExtracted()}
                      disabled={!selectedPhoto}
                      aria-label="恢复程序提取色卡"
                    >
                      <RotateCcw size={13} />
                    </button>
                    <button
                      className="info-block-edit"
                      type="button"
                      onClick={() => {
                        if (paletteEditorOpen) {
                          closePaletteEditor();
                        } else {
                          openPaletteEditor();
                        }
                      }}
                      disabled={!selectedPhoto}
                      aria-label="编辑色卡"
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                </div>
                {copiedPaletteValue ? (
                  <div className="palette-copy-status">
                    {`${TEXT.copiedValue} ${copiedPaletteValue}`}
                  </div>
                ) : null}
                <div className="palette-list">
                  {selectedPhoto ? (
                    selectedPhotoPalette.length > 0 ? (
                      selectedPhotoPalette.map((tone, index) => (
                        <button
                          key={`${selectedPhoto.path}-${tone}-${index}`}
                          className={`palette-item ${
                            activePaletteTone === tone ? "active" : ""
                          }`}
                          onClick={() => void handlePaletteClick(tone)}
                          onMouseEnter={() => handlePaletteHover(tone)}
                          onMouseLeave={() => handlePaletteHover(null)}
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
                      <div className="info-empty">
                        {paletteLoadingPath === selectedPhoto.path
                          ? TEXT.paletteLoading
                          : TEXT.paletteEmpty}
                      </div>
                    )
                  ) : (
                    <div className="info-empty">{TEXT.emptyPalette}</div>
                  )}
                </div>
                {paletteEditorOpen ? (
                  <div className="palette-editor-inline">
                    <div className="palette-editor-toolbar">
                      <button
                        type="button"
                        className="modal-secondary palette-editor-toolbar-button"
                        onClick={addPaletteTone}
                        disabled={paletteDraft.length >= 6}
                      >
                        <Plus size={14} />
                        <span>新增色卡</span>
                      </button>

                      <div className="palette-editor-toolbar-actions">
                        <button
                          type="button"
                          className="modal-secondary"
                          onClick={closePaletteEditor}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="modal-primary"
                          onClick={savePaletteEditor}
                        >
                          保存色卡
                        </button>
                      </div>
                    </div>
                    {paletteHint ? <div className="palette-editor-note">{paletteHint}</div> : null}
                    <div className="palette-editor-inline-header">
                      <button
                        type="button"
                        className="modal-secondary palette-editor-add"
                        onClick={addPaletteTone}
                        disabled={paletteDraft.length >= 6}
                      >
                        <Plus size={14} />
                        <span>鏂板棰滆壊</span>
                      </button>
                      <span>编辑色卡</span>
                      <span>{paletteHint ?? "右侧编辑，主图可继续吸管取色"}</span>
                    </div>
                    <div className="palette-editor-list">
                      {paletteDraft.map((tone, index) => (
                        <div key={`${tone}-${index}`} className="palette-editor-row">
                          <div className="palette-editor-meta">
                            <button
                              type="button"
                              className="palette-editor-swatch"
                              style={{ backgroundColor: tone }}
                              onClick={() => openNativeColorPicker(index)}
                              aria-label="修改色卡颜色"
                            />
                          </div>
                          <div className="palette-editor-actions">
                            <button
                              type="button"
                              className="modal-secondary"
                              onClick={() => beginPalettePicking(index)}
                            >
                              <Pipette size={14} />
                              <span>{pickingPaletteIndex === index ? "取色中" : "吸管"}</span>
                            </button>
                            <button
                              type="button"
                              className="modal-secondary"
                              onClick={() => openNativeColorPicker(index)}
                            >
                              <Pencil size={14} />
                              <span>改色</span>
                            </button>
                            <button
                              type="button"
                              className="modal-danger"
                              onClick={() => removePaletteTone(index)}
                            >
                              <Trash2 size={14} />
                              <span>删除</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="palette-editor-footer">
                      <button
                        type="button"
                        className="modal-secondary"
                        onClick={addPaletteTone}
                        disabled={paletteDraft.length >= 6}
                      >
                        <Plus size={14} />
                        <span>新增颜色</span>
                      </button>
                      <div className="modal-actions">
                        <button
                          type="button"
                          className="modal-secondary"
                          onClick={closePaletteEditor}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="modal-primary"
                          onClick={savePaletteEditor}
                        >
                          保存色卡
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
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
                        requestDeleteGroup(group.id, group.name, currentArtist ?? "");
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
                </>
              )}
            </aside>
          </div>

          {showGroupWorkspace && restorePrompt ? (
            <div className="group-restore-toast" role="status" aria-live="polite">
              <span>是否从上次浏览位置继续观看？</span>
              <div className="group-restore-toast-actions">
                <button type="button" onClick={() => setRestorePrompt(null)}>
                  先不用
                </button>
                <button type="button" className="primary" onClick={continueFromSavedGroupPosition}>
                  继续观看
                </button>
              </div>
            </div>
          ) : null}

          {showGroupWorkspace ? null : (
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
          )}
        </div>
      </main>

      <input
        ref={colorInputRef}
        className="visually-hidden"
        type="color"
        value={
          paletteEditIndex !== null && paletteDraft[paletteEditIndex]
            ? normalizeHex(paletteDraft[paletteEditIndex])
            : "#c8c8d8"
        }
        onChange={(event) => {
          if (paletteEditIndex === null) {
            return;
          }

          updatePaletteTone(paletteEditIndex, event.currentTarget.value);
        }}
      />

      {moveDialogOpen ? (
        <div className="modal-overlay" onClick={closeMoveDialog} role="presentation">
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>移动到分组</h3>
            <p className="modal-subtitle">已选择 {selectedGroupPhotoPaths.length} 张图片</p>

            <div className="move-group-list">
              <button
                type="button"
                className={`move-group-option ${
                  moveTargetGroupId === "unassigned" && !moveNewGroupName.trim() ? "active" : ""
                }`}
                onClick={() => {
                  setMoveTargetGroupId("unassigned");
                  setMoveNewGroupName("");
                }}
              >
                {TEXT.ungrouped}
              </button>
              {currentArtistGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className={`move-group-option ${
                    moveTargetGroupId === group.id && !moveNewGroupName.trim() ? "active" : ""
                  }`}
                  onClick={() => {
                    setMoveTargetGroupId(group.id);
                    setMoveNewGroupName("");
                  }}
                >
                  {group.name}
                </button>
              ))}
            </div>

            <input
              value={moveNewGroupName}
              onChange={(event) => setMoveNewGroupName(event.currentTarget.value)}
              placeholder="或者新建分组后移动，例如：柔雾人像"
            />

            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={closeMoveDialog}>
                取消
              </button>
              <button type="button" className="modal-primary" onClick={confirmMovePhotos}>
                确认移动
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameArtistTarget ? (
        <div className="modal-overlay" onClick={closeRenameArtistDialog} role="presentation">
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>重命名摄影师</h3>
            <p className="modal-subtitle">{renameArtistTarget}</p>
            <input
              autoFocus
              value={renameArtistValue}
              onChange={(event) => setRenameArtistValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void confirmRenameArtist();
                }
                if (event.key === "Escape") {
                  closeRenameArtistDialog();
                }
              }}
              placeholder="输入新的摄影师名字"
            />
            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={closeRenameArtistDialog}>
                取消
              </button>
              <button type="button" className="modal-primary" onClick={() => void confirmRenameArtist()}>
                确认重命名
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {archiveImportPreview ? (
        <div className="modal-overlay" onClick={closeArchiveImportDialog} role="presentation">
          <div
            className="modal-card archive-import-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>导入压缩包</h3>
            <p className="modal-subtitle">识别到摄影师前缀：{archiveImportPreview.parsedPhotographerName}</p>

            <div className="archive-import-mode">
              <label className="archive-import-choice">
                <input
                  type="radio"
                  checked={archiveImportMode === "new"}
                  onChange={() => setArchiveImportMode("new")}
                />
                <span>建立新摄影师</span>
              </label>

              <label className="archive-import-choice">
                <input
                  type="radio"
                  checked={archiveImportMode === "merge"}
                  onChange={() => setArchiveImportMode("merge")}
                />
                <span>合并到已有摄影师</span>
              </label>
            </div>

            {archiveImportMode === "merge" ? (
              <div className="move-group-list archive-merge-list">
                {archiveImportPreview.libraries.map((library) => (
                  <button
                    key={library.directory}
                    type="button"
                    className={`move-group-option ${
                      archiveImportTargetName === library.photographerName ? "active" : ""
                    }`}
                    onClick={() => setArchiveImportTargetName(library.photographerName)}
                  >
                    {`最早：${library.originalName} / 现在：${library.photographerName}`}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={closeArchiveImportDialog}>
                取消
              </button>
              <button type="button" className="modal-primary" onClick={() => void confirmArchiveImport()}>
                确认导入
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
                ? "删除后，这个分组里的图片都会回到未分组，同时这个分组的记事本内容也会一起删除。"
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
