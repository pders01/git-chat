import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repoClient } from "../lib/transport.js";

/* ------------------------------------------------------------------ */
/*  Data model                                                         */
/* ------------------------------------------------------------------ */

interface FileNode {
  path: string;
  name: string;
  commitCount: number;
  additions: number;
  deletions: number;
  lastModified: number;
  size: number;
}

interface DirNode {
  name: string;
  path: string;
  children: DirNode[];
  files: FileNode[];
  totalSize: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SizedItem {
  value: number;
  data: FileNode | DirNode;
}

type ColorMode = "churn" | "activity" | "velocity" | "recency" | "size";
type HeightMode = "commits" | "activity" | "size";

/* ------------------------------------------------------------------ */
/*  Treemap layout                                                     */
/* ------------------------------------------------------------------ */

function squarify(items: SizedItem[], rect: Rect): (Rect & { item: SizedItem })[] {
  if (items.length === 0) return [];

  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return [];

  const sorted = [...items].sort((a, b) => b.value - a.value);
  const results: (Rect & { item: SizedItem })[] = [];

  layoutStrip(sorted, rect, total, results);
  return results;
}

function layoutStrip(
  items: SizedItem[],
  rect: Rect,
  totalValue: number,
  out: (Rect & { item: SizedItem })[],
) {
  if (items.length === 0) return;
  if (items.length === 1) {
    out.push({ ...rect, item: items[0] });
    return;
  }

  const { x, y, w, h } = rect;
  const horizontal = w >= h;
  const side = horizontal ? h : w;

  let rowValue = 0;
  const row: SizedItem[] = [];
  let bestWorst = Infinity;

  for (let i = 0; i < items.length; i++) {
    const candidate = items[i];
    const nextRowValue = rowValue + candidate.value;
    const rowFraction = nextRowValue / totalValue;
    const stripLen = horizontal ? w * rowFraction : h * rowFraction;

    const tempRow = [...row, candidate];
    let worst = 0;
    for (const r of tempRow) {
      const frac = r.value / nextRowValue;
      const itemLen = side * frac;
      const ratio = Math.max(stripLen / itemLen, itemLen / stripLen);
      if (ratio > worst) worst = ratio;
    }

    if (worst <= bestWorst || row.length === 0) {
      row.push(candidate);
      rowValue = nextRowValue;
      bestWorst = worst;
    } else {
      break;
    }
  }

  const rowFraction = rowValue / totalValue;
  const stripLen = horizontal ? w * rowFraction : h * rowFraction;
  let offset = 0;

  for (const item of row) {
    const frac = item.value / rowValue;
    const itemLen = side * frac;
    if (horizontal) {
      out.push({ x, y: y + offset, w: stripLen, h: itemLen, item });
    } else {
      out.push({ x: x + offset, y, w: itemLen, h: stripLen, item });
    }
    offset += itemLen;
  }

  const remaining = items.slice(row.length);
  if (remaining.length > 0) {
    const remainingValue = totalValue - rowValue;
    let nextRect: Rect;
    if (horizontal) {
      nextRect = { x: x + stripLen, y, w: w - stripLen, h };
    } else {
      nextRect = { x, y: y + stripLen, w, h: h - stripLen };
    }
    layoutStrip(remaining, nextRect, remainingValue, out);
  }
}

/* ------------------------------------------------------------------ */
/*  Color helpers                                                      */
/* ------------------------------------------------------------------ */

function getColorForMode(
  file: FileNode,
  mode: ColorMode,
  maxValues: Record<ColorMode, number>,
): number {
  const now = Date.now() / 1000;
  const age = now - file.lastModified;
  const recency = Math.max(0, 1 - age / (90 * 86400));

  switch (mode) {
    case "churn": {
      const intensity = Math.min(1, file.commitCount / Math.max(1, maxValues.churn * 0.6));
      const t = intensity * 0.7 + recency * 0.3;
      const r = Math.round(60 + 195 * t);
      const g = Math.round(80 + 120 * Math.max(0, t - 0.3) * (1 - t));
      const b = Math.round(200 * (1 - t) + 40);
      return (r << 16) | (g << 8) | b;
    }
    case "activity": {
      const activity = file.additions + file.deletions;
      const intensity = Math.min(1, activity / Math.max(1, maxValues.activity * 0.6));
      const t = intensity * 0.7 + recency * 0.3;
      const r = Math.round(60 + 195 * t);
      const g = Math.round(150 + 80 * t * (1 - t));
      const b = Math.round(100 * (1 - t) + 60);
      return (r << 16) | (g << 8) | b;
    }
    case "velocity": {
      const netChange = file.additions - file.deletions;
      const totalChange = file.additions + file.deletions;
      if (totalChange === 0) return 0x4a5568;
      const ratio = netChange / totalChange;
      // Red = mostly deletions (refactoring), Green = mostly additions (new code)
      if (ratio > 0) {
        const intensity = Math.min(1, ratio);
        const r = Math.round(74 + 100 * (1 - intensity));
        const g = Math.round(150 + 80 * intensity);
        const b = Math.round(104 - 40 * intensity);
        return (r << 16) | (g << 8) | b;
      } else {
        const intensity = Math.min(1, -ratio);
        const r = Math.round(200 + 55 * intensity);
        const g = Math.round(80 - 40 * intensity);
        const b = Math.round(80 + 20 * intensity);
        return (r << 16) | (g << 8) | b;
      }
    }
    case "recency": {
      const t = recency;
      const r = Math.round(100 + 100 * t);
      const g = Math.round(100 + 100 * (1 - t));
      const b = Math.round(150 + 50 * Math.sin(t * Math.PI));
      return (r << 16) | (g << 8) | b;
    }
    case "size": {
      const intensity = Math.min(1, file.size / Math.max(1, maxValues.size * 0.8));
      const hue = 200 - intensity * 180;
      const r = Math.round(100 + 100 * Math.sin((hue * Math.PI) / 180));
      const g = Math.round(100 + 80 * Math.cos((hue * Math.PI) / 180));
      const b = Math.round(200 - 100 * intensity);
      return (r << 16) | (g << 8) | b;
    }
  }
}

const DIR_COLORS = [0x2a3040, 0x303a4a, 0x283038, 0x3a3040];

/* ------------------------------------------------------------------ */
/*  Stats computation                                                  */
/* ------------------------------------------------------------------ */

interface CityStats {
  totalFiles: number;
  totalCommits: number;
  totalAdditions: number;
  totalDeletions: number;
  totalSize: number;
  avgCommitsPerFile: number;
  hotFiles: FileNode[];
  newFiles: FileNode[];
  largeFiles: FileNode[];
  oldestTimestamp: number;
  newestTimestamp: number;
}

function computeStats(files: FileNode[]): CityStats {
  if (files.length === 0) {
    return {
      totalFiles: 0,
      totalCommits: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      totalSize: 0,
      avgCommitsPerFile: 0,
      hotFiles: [],
      newFiles: [],
      largeFiles: [],
      oldestTimestamp: 0,
      newestTimestamp: 0,
    };
  }

  let totalCommits = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalSize = 0;
  let oldest = Infinity;
  let newest = 0;

  for (const f of files) {
    totalCommits += f.commitCount;
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
    totalSize += f.size;
    if (f.lastModified > 0) {
      oldest = Math.min(oldest, f.lastModified);
      newest = Math.max(newest, f.lastModified);
    }
  }

  const sortedByCommits = [...files].sort((a, b) => b.commitCount - a.commitCount);
  const sortedByRecency = [...files].sort((a, b) => b.lastModified - a.lastModified);
  const sortedBySize = [...files].sort((a, b) => b.size - a.size);

  const now = Date.now() / 1000;

  return {
    totalFiles: files.length,
    totalCommits,
    totalAdditions,
    totalDeletions,
    totalSize,
    avgCommitsPerFile: totalCommits / files.length,
    hotFiles: sortedByCommits.slice(0, 5),
    newFiles: sortedByRecency.filter((f) => now - f.lastModified < 7 * 86400).slice(0, 5),
    largeFiles: sortedBySize.slice(0, 5),
    oldestTimestamp: oldest === Infinity ? 0 : oldest,
    newestTimestamp: newest,
  };
}

/* ------------------------------------------------------------------ */
/*  Parse flat file list into tree                                     */
/* ------------------------------------------------------------------ */

function parseTree(files: FileNode[]): DirNode {
  const root: DirNode = { name: "", path: "", children: [], files: [], totalSize: 0 };

  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      const dirPath = parts.slice(0, i + 1).join("/");
      let child = cur.children.find((c) => c.path === dirPath);
      if (!child) {
        child = { name: dirName, path: dirPath, children: [], files: [], totalSize: 0 };
        cur.children.push(child);
      }
      cur = child;
    }
    cur.files.push(f);
  }

  function computeSize(node: DirNode): number {
    let size = node.files.reduce((s, f) => s + Math.max(1, f.size), 0);
    for (const child of node.children) {
      size += computeSize(child);
    }
    node.totalSize = size;
    return size;
  }
  computeSize(root);

  return root;
}

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

function formatDate(ts: number): string {
  if (!ts) return "---";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatRelativeTime(ts: number): string {
  if (!ts) return "---";
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return formatDate(ts);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(Math.round(num));
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

type THREE = typeof import("three");

@customElement("gc-code-city")
export class GcCodeCity extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) branch = "";

  @state() private loading = true;
  @state() private error = "";
  @state() private sliderValue = 0;
  private globalTimeRange: [number, number] | null = null; // Fixed bounds from initial load
  private currentSince = 0;
  @state() private colorMode: ColorMode = "churn";
  @state() private heightMode: HeightMode = "commits";
  @state() private showStats = true;
  @state() private selectedFile: FileNode | null = null;

  private three: THREE | null = null;
  private scene: InstanceType<THREE["Scene"]> | null = null;
  private camera: InstanceType<THREE["PerspectiveCamera"]> | null = null;
  private renderer: InstanceType<THREE["WebGLRenderer"]> | null = null;
  private controls: import("three/examples/jsm/controls/OrbitControls.js").OrbitControls | null =
    null;
  private raycaster: InstanceType<THREE["Raycaster"]> | null = null;
  private mouse: InstanceType<THREE["Vector2"]> | null = null;
  private animFrameId = 0;
  private _resizeObserver: ResizeObserver | null = null;
  private blockMeshes: Map<string, InstanceType<THREE["Mesh"]>> = new Map();
  private _maxValues: Record<ColorMode, number> = {
    churn: 1,
    activity: 1,
    velocity: 1,
    recency: 1,
    size: 1,
  };
  private tree: DirNode | null = null;
  private allFiles: FileNode[] = [];
  private stats: CityStats | null = null;
  private sliderTimer = 0;

  override async connectedCallback() {
    super.connectedCallback();
    await this.fetchAndBuild();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>(".city-canvas");
    canvas?.removeEventListener("click", this.onClick);
    canvas?.removeEventListener("mousemove", this.onHover);
    this._resizeObserver?.disconnect();
    this.renderer?.dispose();
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    if (this.sliderTimer) clearTimeout(this.sliderTimer);
  }

  override updated(changed: Map<string, unknown>) {
    if ((changed.has("repoId") || changed.has("branch")) && this.repoId) {
      void this.fetchAndBuild();
    }
    if (changed.has("colorMode") || changed.has("heightMode")) {
      this.rebuildColors();
    }
  }

  /* ---- data fetching ---- */

  private async fetchAndBuild(sinceTimestamp?: number) {
    if (!this.repoId) return;
    this.loading = true;
    this.error = "";

    try {
      const resp = await (repoClient as any).getFileChurnMap({
        repoId: this.repoId,
        ref: this.branch || "",
        sinceTimestamp: String(sinceTimestamp ?? 0),
        untilTimestamp: "0",
      });
      const files: FileNode[] = (resp.files ?? []).map((f: any) => ({
        path: f.path ?? "",
        name: (f.path ?? "").split("/").pop() ?? "",
        commitCount: Number(f.commitCount ?? 0),
        // Handle bigint fields from proto - convert to Number (safe for reasonable values)
        additions: Number(f.totalAdditions ?? f.total_additions ?? 0),
        deletions: Number(f.totalDeletions ?? f.total_deletions ?? 0),
        lastModified: Number(f.lastModified ?? f.last_modified ?? 0),
        size: Number(f.size ?? 1),
      }));

      this.allFiles = files;
      this.stats = computeStats(files);

      // Only update global time bounds on initial load (not on slider changes)
      if (!sinceTimestamp && files.length > 0) {
        const times = files.map((f) => f.lastModified).filter((t) => t > 0);
        if (times.length > 0) {
          const oldest = Math.min(...times);
          const now = Math.floor(Date.now() / 1000);
          this.globalTimeRange = [oldest, now];
          this.currentSince = oldest;
          this.sliderValue = 0;
        }
      } else if (files.length === 0 && sinceTimestamp) {
        // Empty result from slider - don't update bounds, just show empty state
        this.error = "No activity in selected time window";
      }

      // Compute max values for color normalization using global bounds
      this._maxValues = {
        churn: Math.max(1, ...files.map((f) => f.commitCount)),
        activity: Math.max(1, ...files.map((f) => f.additions + f.deletions)),
        velocity: Math.max(1, ...files.map((f) => Math.abs(f.additions - f.deletions))),
        recency: Math.max(1, Math.floor(Date.now() / 1000) - Math.min(...files.map((f) => f.lastModified || Infinity))),
        size: Math.max(1, ...files.map((f) => f.size)),
      };

      this.tree = parseTree(files);
      this.loading = false;

      await this.updateComplete;
      await this.initScene();
      this.buildCity();
    } catch (e) {
      this.loading = false;
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /* ---- Three.js init ---- */

  private async initScene() {
    if (this.scene) return;

    const THREE = await import("three");
    const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

    this.three = THREE;

    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>(".city-canvas");
    if (!canvas) return;

    const container = canvas.parentElement!;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 600;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1d24);

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    this.camera.position.set(30, 30, 30);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(20, 40, 20);
    directional.castShadow = true;
    directional.shadow.mapSize.width = 2048;
    directional.shadow.mapSize.height = 2048;
    this.scene.add(directional);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.MeshStandardMaterial({ color: 0x2a2d36 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("mousemove", this.onHover);

    this._resizeObserver = new ResizeObserver(() => {
      const { width: w, height: h } = container.getBoundingClientRect();
      if (w === 0 || h === 0) return;
      this.camera!.aspect = w / h;
      this.camera!.updateProjectionMatrix();
      this.renderer!.setSize(w, h);
    });
    this._resizeObserver.observe(container);

    this.renderLoop();
  }

  /* ---- city geometry ---- */

  private buildCity() {
    if (!this.three || !this.scene || !this.tree) return;

    // Clear old meshes
    for (const mesh of this.blockMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as InstanceType<(typeof this.three)["MeshStandardMaterial"]>).dispose();
    }
    this.blockMeshes.clear();

    const toRemove: InstanceType<(typeof this.three)["Object3D"]>[] = [];
    this.scene.traverse((obj) => {
      if ((obj as any).userData?.isDir) toRemove.push(obj);
    });
    for (const obj of toRemove) {
      this.scene.remove(obj);
      if ((obj as any).geometry) (obj as any).geometry.dispose();
      if ((obj as any).material) (obj as any).material.dispose();
    }

    const citySize = Math.max(10, Math.sqrt(this.tree.totalSize) * 0.05);
    const rootRect: Rect = { x: -citySize / 2, y: -citySize / 2, w: citySize, h: citySize };

    this.layoutDir(this.tree, rootRect, 0);

    this.camera!.position.set(citySize * 0.8, citySize * 0.8, citySize * 0.8);
    this.camera!.lookAt(0, 0, 0);
  }

  private layoutDir(dir: DirNode, rect: Rect, depth: number) {
    if (!this.three || !this.scene) return;
    const THREE = this.three;

    if (depth > 0) {
      const pad = 0.05;
      const ground = new THREE.Mesh(
        new THREE.BoxGeometry(rect.w - pad, 0.05, rect.h - pad),
        new THREE.MeshStandardMaterial({ color: DIR_COLORS[depth % DIR_COLORS.length] }),
      );
      ground.position.set(rect.x + rect.w / 2, 0.025, rect.y + rect.h / 2);
      ground.receiveShadow = true;
      ground.userData = { isDir: true, path: dir.path };
      this.scene.add(ground);
    }

    const items: SizedItem[] = [];
    for (const child of dir.children) {
      if (child.totalSize > 0) {
        items.push({ value: child.totalSize, data: child });
      }
    }
    for (const file of dir.files) {
      items.push({ value: Math.max(1, file.size), data: file });
    }

    if (items.length === 0) return;

    const inset = depth > 0 ? 0.15 : 0;
    const innerRect: Rect = {
      x: rect.x + inset,
      y: rect.y + inset,
      w: Math.max(0.1, rect.w - inset * 2),
      h: Math.max(0.1, rect.h - inset * 2),
    };

    const layout = squarify(items, innerRect);

    for (const placed of layout) {
      const item = placed.item;
      if ("children" in item.data && "files" in item.data) {
        this.layoutDir(item.data as DirNode, placed, depth + 1);
      } else {
        const file = item.data as FileNode;
        this.buildBlock(file, placed.x, placed.y, placed.w, placed.h);
      }
    }
  }

  private buildBlock(file: FileNode, x: number, z: number, w: number, d: number) {
    if (!this.three || !this.scene) return;
    const THREE = this.three;

    let height: number;
    switch (this.heightMode) {
      case "commits":
        height = Math.max(0.1, Math.log2(file.commitCount + 1) * 2);
        break;
      case "activity":
        height = Math.max(0.1, Math.log2(file.additions + file.deletions + 1) * 1.5);
        break;
      case "size":
        height = Math.max(0.1, Math.log2(file.size + 1) * 0.5);
        break;
    }

    const color = getColorForMode(file, this.colorMode, this._maxValues);

    const geometry = new THREE.BoxGeometry(w * 0.9, height, d * 0.9);
    const material = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x + w / 2, height / 2, z + d / 2);
    mesh.castShadow = true;
    mesh.userData = { path: file.path, file };
    this.scene.add(mesh);
    this.blockMeshes.set(file.path, mesh);
  }

  private rebuildColors() {
    if (!this.three || !this.scene) return;
    const THREE = this.three;

    for (const [path, mesh] of this.blockMeshes) {
      const file = this.allFiles.find((f) => f.path === path);
      if (!file) continue;

      const color = getColorForMode(file, this.colorMode, this._maxValues);
      (mesh.material as InstanceType<typeof THREE.MeshStandardMaterial>).color.setHex(color);

      // Rebuild geometry for height changes
      const pos = mesh.position;
      const geo = mesh.geometry as InstanceType<typeof THREE.BoxGeometry>;
      const params = geo.parameters;
      const w = params.width;
      const d = params.depth;

      let height: number;
      switch (this.heightMode) {
        case "commits":
          height = Math.max(0.1, Math.log2(file.commitCount + 1) * 2);
          break;
        case "activity":
          height = Math.max(0.1, Math.log2(file.additions + file.deletions + 1) * 1.5);
          break;
        case "size":
          height = Math.max(0.1, Math.log2(file.size + 1) * 0.5);
          break;
      }

      mesh.geometry.dispose();
      mesh.geometry = new THREE.BoxGeometry(w, height, d);
      mesh.position.set(pos.x, height / 2, pos.z);
    }
  }

  /* ---- animation ---- */

  private renderLoop = () => {
    this.animFrameId = requestAnimationFrame(this.renderLoop);
    this.controls?.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  };

  /* ---- click / hover ---- */

  @state() private tooltipText = "";
  @state() private tooltipX = 0;
  @state() private tooltipY = 0;

  private onHover = (event: MouseEvent) => {
    if (!this.raycaster || !this.mouse || !this.camera || !this.scene) return;
    const canvas = event.target as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects([...this.blockMeshes.values()]);
    if (intersects.length > 0) {
      const hit = intersects[0].object;
      const f = hit.userData?.file as FileNode;
      this.tooltipText = f ? this.renderTooltipContent(f) : "";
      this.tooltipX = event.clientX - rect.left;
      this.tooltipY = event.clientY - rect.top;
      canvas.style.cursor = "pointer";
    } else {
      this.tooltipText = "";
      canvas.style.cursor = "default";
    }
  };

  private renderTooltipContent(f: FileNode): string {
    const activity = f.additions + f.deletions;
    const netChange = f.additions - f.deletions;
    const netLabel = netChange >= 0 ? `+${formatNumber(netChange)}` : `-${formatNumber(-netChange)}`;

    return [
      f.path,
      ``,
      `${f.commitCount} commits · ${formatRelativeTime(f.lastModified)}`,
      `${formatBytes(f.size)} · +${formatNumber(f.additions)}/-${formatNumber(f.deletions)}`,
      `${netLabel} net · ${activity > 0 ? formatNumber(activity) : 0} churned`,
    ].join("\n");
  }

  private onClick = (event: MouseEvent) => {
    if (!this.raycaster || !this.mouse || !this.camera || !this.scene) return;

    const canvas = event.target as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects([...this.blockMeshes.values()]);

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      const file = hit.userData?.file as FileNode;
      if (file) {
        this.selectedFile = file;
      }
    } else {
      this.selectedFile = null;
    }
  };

  /* ---- time slider ---- */

  private onTimeChange = (e: Event) => {
    const val = Number((e.target as HTMLInputElement).value);
    this.sliderValue = val;
    this.updateSinceFromSlider(val);

    clearTimeout(this.sliderTimer);
    this.sliderTimer = window.setTimeout(() => {
      void this.fetchAndBuild(this.currentSince);
    }, 300);
  };

  private updateSinceFromSlider(val: number) {
    if (!this.globalTimeRange) return;
    const [oldest, now] = this.globalTimeRange;
    if (now <= oldest) {
      this.currentSince = oldest;
      return;
    }
    // Slider 0 = all history (since = oldest)
    // Slider 100 = recent window (since = now - 1 day minimum to avoid empty)
    const timeSpan = now - oldest;
    const minWindow = 86400; // Always show at least 24h of data at max slider
    const maxSince = now - minWindow;
    const rawSince = oldest + (val / 100) * timeSpan;
    this.currentSince = Math.min(Math.floor(rawSince), maxSince);
  }

  private getSliderLabel(): string {
    if (!this.globalTimeRange) return "loading...";
    const [globalOldest, now] = this.globalTimeRange;
    if (now <= globalOldest) return "all history";

    const currentSpan = now - this.currentSince;
    const totalSpan = now - globalOldest;
    const percentage = (currentSpan / totalSpan) * 100;

    // Show relative time window
    if (percentage > 95) return "all history";
    if (currentSpan < 86400) return "last 24 hours";
    if (currentSpan < 7 * 86400) return `last ${Math.round(currentSpan / 86400)} days`;
    if (currentSpan < 30 * 86400) return `last ${Math.round(currentSpan / (7 * 86400))} weeks`;
    if (currentSpan < 365 * 86400) return `last ${Math.round(currentSpan / (30 * 86400))} months`;
    return `last ${(currentSpan / (365 * 86400)).toFixed(1)} years`;
  }

  /* ---- render ---- */

  private renderStatsPanel() {
    if (!this.stats || !this.showStats) return nothing;

    const s = this.stats;
    const netChange = s.totalAdditions - s.totalDeletions;
    const totalActivity = s.totalAdditions + s.totalDeletions;
    // Code velocity: what % of activity is net new code vs churn
    const velocityPct = totalActivity > 0 
      ? ((s.totalAdditions / totalActivity) * 100).toFixed(0)
      : "0";
    // Churn rate: lines changed per commit
    const churnRate = s.totalCommits > 0 
      ? Math.round(totalActivity / s.totalCommits)
      : 0;

    return html`
      <div class="stats-panel" ?hidden=${!this.showStats}>
        <div class="stats-header">
          <span class="stats-title">Repository Stats</span>
          <button class="stats-close" @click=${() => (this.showStats = false)}>×</button>
        </div>
        
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-value">${formatNumber(s.totalFiles)}</span>
            <span class="stat-label">files</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${formatNumber(s.totalCommits)}</span>
            <span class="stat-label">commits</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">+${formatNumber(s.totalAdditions)}</span>
            <span class="stat-label">additions</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">-${formatNumber(s.totalDeletions)}</span>
            <span class="stat-label">deletions</span>
          </div>
        </div>

        <div class="stats-summary">
          <span class="growth-badge ${netChange >= 0 ? "positive" : "negative"}">
            ${netChange >= 0 ? "+" : "-"}${formatNumber(Math.abs(netChange))} net
          </span>
          <span class="velocity-badge">${velocityPct}% new code</span>
          <span class="churn-badge">~${formatNumber(churnRate)} lines/commit</span>
        </div>

        ${s.hotFiles.length > 0 ? html`
          <div class="stats-section">
            <span class="section-title">Hot Files</span>
            ${s.hotFiles.map(f => html`
              <div class="file-row" @click=${() => this.dispatchOpenFile(f.path)}>
                <span class="file-name">${f.name}</span>
                <span class="file-metric">${f.commitCount}c</span>
              </div>
            `)}
          </div>
        ` : nothing}

        ${s.newFiles.length > 0 ? html`
          <div class="stats-section">
            <span class="section-title">New This Week</span>
            ${s.newFiles.map(f => html`
              <div class="file-row" @click=${() => this.dispatchOpenFile(f.path)}>
                <span class="file-name">${f.name}</span>
                <span class="file-metric">${formatRelativeTime(f.lastModified)}</span>
              </div>
            `)}
          </div>
        ` : nothing}

        ${s.largeFiles.length > 0 ? html`
          <div class="stats-section">
            <span class="section-title">Largest</span>
            ${s.largeFiles.slice(0, 3).map(f => html`
              <div class="file-row" @click=${() => this.dispatchOpenFile(f.path)}>
                <span class="file-name">${f.name}</span>
                <span class="file-metric">${formatBytes(f.size)}</span>
              </div>
            `)}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private dispatchOpenFile(path: string) {
    this.selectedFile = null; // Close the detail modal
    this.dispatchEvent(
      new CustomEvent("gc:open-file", {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderFileDetail() {
    if (!this.selectedFile) return nothing;
    const f = this.selectedFile;
    const activity = f.additions + f.deletions;
    const netChange = f.additions - f.deletions;

    return html`
      <div class="file-detail" @click=${(e: Event) => e.stopPropagation()}>
        <div class="detail-header">
          <span class="detail-path">${f.path}</span>
          <button class="detail-close" @click=${() => (this.selectedFile = null)}>×</button>
        </div>
        
        <div class="detail-stats">
          <div class="detail-stat">
            <span class="detail-value">${f.commitCount}</span>
            <span class="detail-label">commits</span>
          </div>
          <div class="detail-stat">
            <span class="detail-value">${formatBytes(f.size)}</span>
            <span class="detail-label">size</span>
          </div>
          <div class="detail-stat">
            <span class="detail-value">${formatRelativeTime(f.lastModified)}</span>
            <span class="detail-label">modified</span>
          </div>
        </div>

        <div class="detail-changes">
          <div class="change-bar">
            <span class="change-label">Changes</span>
            <span class="change-value">+${formatNumber(f.additions)} / -${formatNumber(f.deletions)}</span>
          </div>
          <div class="net-bar ${netChange >= 0 ? "positive" : "negative"}">
            <span class="net-label">Net</span>
            <span class="net-value">${netChange >= 0 ? "+" : ""}${formatNumber(netChange)}</span>
          </div>
          ${activity > 0 ? html`
            <div class="ratio-bar">
              <span class="ratio-label">Ratio</span>
              <div class="ratio-visual">
                <div class="ratio-add" style="width: ${(f.additions / activity) * 100}%"></div>
                <div class="ratio-del" style="width: ${(f.deletions / activity) * 100}%"></div>
              </div>
            </div>
          ` : nothing}
        </div>

        <div class="detail-actions">
          <button class="detail-btn" @click=${() => this.dispatchOpenFile(f.path)}>
            View File
          </button>
          <button class="detail-btn secondary" @click=${() => this.dispatchEvent(
            new CustomEvent("gc:explain-in-chat", {
              detail: { path: f.path },
              bubbles: true,
              composed: true,
            })
          )}>
            Explain in Chat
          </button>
        </div>
      </div>
    `;
  }

  private renderLegend() {
    const modes: { value: ColorMode; label: string; desc: string }[] = [
      { value: "churn", label: "Churn", desc: "Commit frequency (hot = many commits)" },
      { value: "activity", label: "Activity", desc: "Total changes (additions + deletions)" },
      { value: "velocity", label: "Velocity", desc: "Green = more additions, Red = more deletions" },
      { value: "recency", label: "Recency", desc: "How recently modified" },
      { value: "size", label: "Size", desc: "File size in bytes" },
    ];

    const heights: { value: HeightMode; label: string }[] = [
      { value: "commits", label: "Commits" },
      { value: "activity", label: "Activity" },
      { value: "size", label: "Size" },
    ];

    return html`
      <div class="legend-panel">
        <div class="legend-row">
          <span class="legend-label">Color:</span>
          <select class="legend-select" @change=${(e: Event) => this.colorMode = (e.target as HTMLSelectElement).value as ColorMode}>
            ${modes.map(m => html`
              <option value=${m.value} ?selected=${this.colorMode === m.value}>
                ${m.label}
              </option>
            `)}
          </select>
        </div>
        <div class="legend-row">
          <span class="legend-label">Height:</span>
          <select class="legend-select" @change=${(e: Event) => this.heightMode = (e.target as HTMLSelectElement).value as HeightMode}>
            ${heights.map(h => html`
              <option value=${h.value} ?selected=${this.heightMode === h.value}>
                ${h.label}
              </option>
            `)}
          </select>
        </div>
        <div class="legend-desc">
          ${modes.find(m => m.value === this.colorMode)?.desc}
        </div>
        ${!this.showStats ? html`
          <button class="show-stats-btn" @click=${() => this.showStats = true}>
            Show Stats Panel
          </button>
        ` : nothing}
      </div>
    `;
  }

  override render() {
    if (this.loading && !this.scene) return html`<div class="hint">loading activity data...</div>`;
    if (this.error && !this.scene) return html`<div class="hint err">${this.error}</div>`;

    return html`
      <div class="city-container">
        <canvas
          class="city-canvas"
          role="img"
          aria-label="Code city visualization — file activity as 3D buildings"
        ></canvas>
        ${this.loading ? html`<div class="city-loading">updating...</div>` : nothing}
        ${this.tooltipText
          ? html`<div
              class="city-tooltip"
              style="left:${this.tooltipX + 12}px;top:${this.tooltipY - 8}px"
            >
              <pre>${this.tooltipText}</pre>
            </div>`
          : nothing}
        
        ${this.renderStatsPanel()}
        ${this.renderLegend()}
        ${this.renderFileDetail()}

        <div class="city-controls">
          <span class="time-label start">${this.globalTimeRange ? formatDate(this.globalTimeRange[0]) : "..."}</span>
          <div class="slider-wrapper">
            <input
              type="range"
              class="time-slider"
              aria-label="Time window slider — drag to adjust how much history to display"
              min="0"
              max="100"
              .value=${String(this.sliderValue)}
              @input=${this.onTimeChange}
            />
            <span class="slider-label">${this.getSliderLabel()}</span>
          </div>
          <span class="time-label end">${this.globalTimeRange ? formatDate(this.globalTimeRange[1]) : "..."}</span>
        </div>
      </div>
    `;
  }

  static override styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .city-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      position: relative;
    }
    .city-canvas {
      flex: 1;
      min-height: 0;
      display: block;
      width: 100%;
    }
    .city-loading {
      position: absolute;
      top: var(--space-2);
      right: var(--space-3);
      font-size: var(--text-xs);
      opacity: 0.5;
    }
    .city-tooltip {
      position: absolute;
      padding: 8px 12px;
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      pointer-events: none;
      white-space: nowrap;
      z-index: 100;
      max-width: 400px;
    }
    .city-tooltip pre {
      margin: 0;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      line-height: 1.4;
    }
    .city-controls {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2) var(--space-4);
      border-top: 1px solid var(--surface-4);
      background: var(--surface-1);
    }
    .time-slider {
      flex: 1;
      accent-color: var(--accent-user);
    }
    .time-label {
      font-size: var(--text-xs);
      opacity: 0.5;
      min-width: 70px;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .time-label.start {
      text-align: left;
    }
    .time-label.end {
      text-align: right;
    }
    .slider-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    .slider-label {
      font-size: var(--text-xs);
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      color: var(--accent-user);
      height: 16px;
    }
    .hint, .err {
      padding: var(--space-5);
      opacity: 0.55;
      margin: 0;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .err {
      color: var(--danger);
      opacity: 1;
    }

    /* Stats Panel */
    .stats-panel {
      position: absolute;
      top: var(--space-3);
      left: var(--space-3);
      width: 280px;
      max-height: calc(100% - 100px);
      overflow-y: auto;
      background: var(--surface-1);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      padding: var(--space-3);
      z-index: 50;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .stats-panel[hidden] {
      display: none;
    }
    .stats-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--space-3);
      padding-bottom: var(--space-2);
      border-bottom: 1px solid var(--surface-4);
    }
    .stats-title {
      font-weight: 600;
      font-size: var(--text-sm);
    }
    .stats-close {
      background: none;
      border: none;
      color: var(--text);
      font-size: var(--text-lg);
      cursor: pointer;
      padding: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .stats-close:hover {
      background: var(--surface-3);
      border-radius: var(--radius-sm);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-2);
      margin-bottom: var(--space-3);
    }
    .stat-item {
      background: var(--surface-2);
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      text-align: center;
    }
    .stat-value {
      display: block;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--accent-user);
    }
    .stat-label {
      display: block;
      font-size: var(--text-xs);
      opacity: 0.6;
      margin-top: 2px;
    }
    .stats-summary {
      display: flex;
      gap: var(--space-2);
      margin-bottom: var(--space-3);
      flex-wrap: wrap;
    }
    .growth-badge {
      font-size: var(--text-xs);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .growth-badge.positive {
      background: rgba(74, 222, 128, 0.2);
      color: #4ade80;
    }
    .growth-badge.negative {
      background: rgba(248, 113, 113, 0.2);
      color: #f87171;
    }
    .velocity-badge, .churn-badge {
      font-size: var(--text-xs);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--surface-3);
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .avg-badge {
      font-size: var(--text-xs);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--surface-3);
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .stats-section {
      margin-top: var(--space-3);
      padding-top: var(--space-2);
      border-top: 1px solid var(--surface-4);
    }
    .section-title {
      display: block;
      font-size: var(--text-xs);
      font-weight: 600;
      margin-bottom: var(--space-2);
      opacity: 0.8;
    }
    .file-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-1) var(--space-2);
      font-size: var(--text-xs);
      cursor: pointer;
      border-radius: var(--radius-sm);
    }
    .file-row:hover {
      background: var(--surface-3);
    }
    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 160px;
    }
    .file-metric {
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      opacity: 0.6;
      flex-shrink: 0;
    }

    /* Legend Panel */
    .legend-panel {
      position: absolute;
      top: var(--space-3);
      right: var(--space-3);
      width: 220px;
      background: var(--surface-1);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      padding: var(--space-3);
      z-index: 50;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-2);
    }
    .legend-label {
      font-size: var(--text-xs);
      opacity: 0.7;
      min-width: 45px;
    }
    .legend-select {
      flex: 1;
      min-width: 80px;
      height: 24px;
      padding: 0 var(--space-2);
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%23888'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 6px center;
      padding-right: 20px;
    }
    .legend-select:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .legend-desc {
      font-size: var(--text-xs);
      opacity: 0.6;
      margin-top: var(--space-2);
      padding-top: var(--space-2);
      border-top: 1px solid var(--surface-4);
      line-height: 1.4;
    }
    .show-stats-btn {
      width: 100%;
      margin-top: var(--space-2);
      padding: var(--space-2);
      background: var(--surface-3);
      border: 1px solid var(--surface-4);
      color: var(--text);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .show-stats-btn:hover {
      background: var(--surface-4);
    }

    /* File Detail Panel */
    .file-detail {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 320px;
      background: var(--surface-1);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      z-index: 100;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }
    .detail-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: var(--space-3);
      gap: var(--space-2);
    }
    .detail-path {
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: var(--text-xs);
      word-break: break-all;
      line-height: 1.4;
    }
    .detail-close {
      background: none;
      border: none;
      color: var(--text);
      font-size: var(--text-lg);
      cursor: pointer;
      padding: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .detail-close:hover {
      background: var(--surface-3);
      border-radius: var(--radius-sm);
    }
    .detail-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-2);
      margin-bottom: var(--space-3);
    }
    .detail-stat {
      text-align: center;
      padding: var(--space-2);
      background: var(--surface-2);
      border-radius: var(--radius-sm);
    }
    .detail-value {
      display: block;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--accent-user);
    }
    .detail-label {
      display: block;
      font-size: var(--text-xs);
      opacity: 0.6;
      margin-top: 2px;
    }
    .detail-changes {
      background: var(--surface-2);
      border-radius: var(--radius-sm);
      padding: var(--space-3);
      margin-bottom: var(--space-3);
    }
    .change-bar, .net-bar, .ratio-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--space-2);
      font-size: var(--text-xs);
    }
    .change-bar {
      margin-bottom: var(--space-2);
    }
    .change-label, .net-label, .ratio-label {
      opacity: 0.7;
    }
    .change-value {
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .net-value {
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-weight: 600;
    }
    .net-bar.positive .net-value {
      color: #4ade80;
    }
    .net-bar.negative .net-value {
      color: #f87171;
    }
    .ratio-visual {
      display: flex;
      width: 60px;
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
    }
    .ratio-add {
      background: #4ade80;
      height: 100%;
    }
    .ratio-del {
      background: #f87171;
      height: 100%;
    }
    .detail-actions {
      display: flex;
      gap: var(--space-2);
    }
    .detail-btn {
      flex: 1;
      padding: var(--space-2) var(--space-3);
      background: var(--accent-user);
      color: white;
      border: none;
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      cursor: pointer;
      font-weight: 500;
    }
    .detail-btn:hover {
      opacity: 0.9;
    }
    .detail-btn.secondary {
      background: var(--surface-3);
      color: var(--text);
    }
  `;
}
