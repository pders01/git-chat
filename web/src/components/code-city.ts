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

/* ------------------------------------------------------------------ */
/*  Treemap layout                                                     */
/* ------------------------------------------------------------------ */

function squarify(items: SizedItem[], rect: Rect): (Rect & { item: SizedItem })[] {
  if (items.length === 0) return [];

  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return [];

  // Sort descending by value for better aspect ratios
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

  // Greedily add items to the current row until aspect ratio worsens.
  let rowValue = 0;
  const row: SizedItem[] = [];
  let bestWorst = Infinity;

  for (let i = 0; i < items.length; i++) {
    const candidate = items[i];
    const nextRowValue = rowValue + candidate.value;
    const rowFraction = nextRowValue / totalValue;
    const stripLen = horizontal ? w * rowFraction : h * rowFraction;

    // Compute worst aspect ratio if we add this item
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

  // Lay out the row
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

  // Recurse into remaining items with the leftover rectangle
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

// Color by commit count intensity — high churn = hot, low = cool.
// Also factors in recency as a secondary signal.
function churnColor(lastModified: number, commitCount = 1, maxCommits = 10): number {
  // Primary: commit count intensity (0=cold, 1=hot)
  const intensity = Math.min(1, commitCount / Math.max(1, maxCommits * 0.6));
  // Secondary: recency (0=old, 1=recent)
  const now = Date.now() / 1000;
  const age = now - lastModified;
  const recency = Math.max(0, 1 - age / (90 * 86400));
  // Blend: 70% intensity, 30% recency
  const t = intensity * 0.7 + recency * 0.3;
  // Cool blue → warm orange → hot red
  const r = Math.round(60 + 195 * t);
  const g = Math.round(80 + 120 * Math.max(0, t - 0.3) * (1 - t));
  const b = Math.round(200 * (1 - t) + 40);
  return (r << 16) | (g << 8) | b;
}

const DIR_COLORS = [0x2a3040, 0x303a4a, 0x283038, 0x3a3040];

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

  // Compute totalSize bottom-up
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
/*  Format helper                                                      */
/* ------------------------------------------------------------------ */

function formatDate(ts: number): string {
  if (!ts) return "---";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

// Lazily loaded Three.js module references
type THREE = typeof import("three");

@customElement("gc-code-city")
export class GcCodeCity extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) branch = "";

  @state() private loading = true;
  @state() private error = "";
  @state() private timeRange: [number, number] = [0, Math.floor(Date.now() / 1000)];
  @state() private currentSince = 0;

  // Three.js internals (not reactive)
  private three: THREE | null = null;
  private scene: InstanceType<THREE["Scene"]> | null = null;
  private camera: InstanceType<THREE["PerspectiveCamera"]> | null = null;
  private renderer: InstanceType<THREE["WebGLRenderer"]> | null = null;
  private controls: import("three/examples/jsm/controls/OrbitControls.js").OrbitControls | null = null;
  private raycaster: InstanceType<THREE["Raycaster"]> | null = null;
  private mouse: InstanceType<THREE["Vector2"]> | null = null;
  private animFrameId = 0;
  private _resizeObserver: ResizeObserver | null = null;
  private blockMeshes: Map<string, InstanceType<THREE["Mesh"]>> = new Map();
  private _maxCommits = 1;
  private tree: DirNode | null = null;

  // Debounce timer for slider
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
  }

  /* ---- data fetching ---- */

  private async fetchAndBuild(sinceTimestamp?: number) {
    if (!this.repoId) return;
    this.loading = true;
    this.error = "";

    try {
      if (!this.repoId) {
        this.loading = false;
        return;
      }
      const resp = await (repoClient as any).getFileChurnMap({
        repoId: this.repoId,
        ref: this.branch || "",
        sinceTimestamp: String(sinceTimestamp ?? 0),
        untilTimestamp: "0",
      });
      const files: FileNode[] = (resp.files ?? []).map((f: any) => ({
        path: f.path ?? "",
        name: (f.path ?? "").split("/").pop() ?? "",
        commitCount: Number(f.commitCount ?? f.commit_count ?? 0),
        additions: Number(f.additions ?? 0),
        deletions: Number(f.deletions ?? 0),
        lastModified: Number(f.lastModified ?? f.last_modified ?? 0),
        size: Number(f.size ?? 1),
      }));

      // Derive time range from data
      if (files.length > 0) {
        const times = files.map((f) => f.lastModified).filter((t) => t > 0);
        if (times.length > 0) {
          const oldest = Math.min(...times);
          const now = Math.floor(Date.now() / 1000);
          this.timeRange = [oldest, now];
          if (!sinceTimestamp) this.currentSince = oldest;
        }
      }

      this.tree = parseTree(files);
      this.loading = false;

      // Wait for lit to render the canvas
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
    if (this.scene) {
      // Scene already exists — just rebuild geometry
      return;
    }

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

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(20, 40, 20);
    directional.castShadow = true;
    directional.shadow.mapSize.width = 2048;
    directional.shadow.mapSize.height = 2048;
    this.scene.add(directional);

    // Ground plane
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.MeshStandardMaterial({ color: 0x2a2d36 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Click + hover handlers
    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("mousemove", this.onHover);

    // Resize
    this._resizeObserver = new ResizeObserver(() => {
      const { width: w, height: h } = container.getBoundingClientRect();
      if (w === 0 || h === 0) return;
      this.camera!.aspect = w / h;
      this.camera!.updateProjectionMatrix();
      this.renderer!.setSize(w, h);
    });
    this._resizeObserver.observe(container);

    // Animation loop
    this.animate();
  }

  /* ---- city geometry ---- */

  private buildCity() {
    if (!this.three || !this.scene || !this.tree) return;
    const THREE = this.three;

    // Clear old block meshes
    for (const mesh of this.blockMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as InstanceType<THREE["MeshStandardMaterial"]>).dispose();
    }
    this.blockMeshes.clear();

    // Also remove old directory ground planes (tagged with userData.isDir)
    const toRemove: InstanceType<THREE["Object3D"]>[] = [];
    this.scene.traverse((obj) => {
      if ((obj as any).userData?.isDir) toRemove.push(obj);
    });
    for (const obj of toRemove) {
      this.scene.remove(obj);
      if ((obj as any).geometry) (obj as any).geometry.dispose();
      if ((obj as any).material) (obj as any).material.dispose();
    }

    // Compute max commits for color normalization
    const allFiles: FileNode[] = [];
    const collectFiles = (dir: DirNode) => { allFiles.push(...dir.files); dir.children.forEach(collectFiles); };
    collectFiles(this.tree);
    this._maxCommits = Math.max(1, ...allFiles.map(f => f.commitCount));

    // Total city size proportional to sqrt of total size
    const citySize = Math.max(10, Math.sqrt(this.tree.totalSize) * 0.05);
    const rootRect: Rect = { x: -citySize / 2, y: -citySize / 2, w: citySize, h: citySize };

    this.layoutDir(this.tree, rootRect, 0);

    // Adjust camera to see the whole city
    this.camera!.position.set(citySize * 0.8, citySize * 0.8, citySize * 0.8);
    this.camera!.lookAt(0, 0, 0);
  }

  private layoutDir(dir: DirNode, rect: Rect, depth: number) {
    if (!this.three || !this.scene) return;
    const THREE = this.three;

    // Draw directory ground plane
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

    // Collect all items (subdirs + files) with their sizes
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

    // Inset the rectangle slightly for visual separation
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
        // It's a DirNode — recurse
        this.layoutDir(item.data as DirNode, placed, depth + 1);
      } else {
        // It's a FileNode — build a block
        const file = item.data as FileNode;
        this.buildBlock(file, placed.x, placed.y, placed.w, placed.h);
      }
    }
  }

  private buildBlock(file: FileNode, x: number, z: number, w: number, d: number) {
    if (!this.three || !this.scene) return;
    const THREE = this.three;

    const height = Math.max(0.1, Math.log2(file.commitCount + 1) * 2);
    const color = churnColor(file.lastModified, file.commitCount, this._maxCommits);

    const geometry = new THREE.BoxGeometry(w * 0.9, height, d * 0.9);
    const material = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x + w / 2, height / 2, z + d / 2);
    mesh.castShadow = true;
    mesh.userData = { path: file.path, file };
    this.scene.add(mesh);
    this.blockMeshes.set(file.path, mesh);
  }

  /* ---- animation ---- */

  private animate = () => {
    this.animFrameId = requestAnimationFrame(this.animate);
    this.controls?.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  };

  /* ---- click / raycast ---- */

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
      const f = hit.userData?.file;
      const path = hit.userData?.path ?? "";
      this.tooltipText = f ? `${path} (${f.commitCount} commits, +${f.additions}/-${f.deletions})` : path;
      this.tooltipX = event.clientX - rect.left;
      this.tooltipY = event.clientY - rect.top;
      canvas.style.cursor = "pointer";
    } else {
      this.tooltipText = "";
      canvas.style.cursor = "default";
    }
  };

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
      const path = hit.userData?.path;
      if (path) {
        this.dispatchEvent(
          new CustomEvent("gc:open-file", {
            detail: { path },
            bubbles: true,
            composed: true,
          }),
        );
      }
    }
  };

  /* ---- time slider ---- */

  private onTimeChange = (e: Event) => {
    const value = Number((e.target as HTMLInputElement).value);
    this.currentSince = value;

    clearTimeout(this.sliderTimer);
    this.sliderTimer = window.setTimeout(() => {
      void this.fetchAndBuild(value);
    }, 300);
  };

  private animateHeight(
    mesh: InstanceType<THREE["Mesh"]>,
    targetHeight: number,
    targetColor: number,
  ) {
    if (!this.three) return;
    const THREE = this.three;

    const startY = mesh.position.y;
    const startScale = mesh.scale.y;
    const targetScale = targetHeight / (mesh.geometry as any).parameters?.height || 1;
    const startTime = performance.now();
    const duration = 500;

    const mat = mesh.material as InstanceType<THREE["MeshStandardMaterial"]>;
    const startColor = mat.color.clone();
    const endColor = new THREE.Color(targetColor);

    const step = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / duration);
      const ease = t * (2 - t); // ease-out quad

      mesh.scale.y = startScale + (targetScale - startScale) * ease;
      mesh.position.y = (mesh.geometry as any).parameters.height * mesh.scale.y / 2;
      mat.color.lerpColors(startColor, endColor, ease);

      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---- render ---- */

  override render() {
    if (this.loading && !this.scene) return html`<div class="hint">loading activity data...</div>`;
    if (this.error && !this.scene) return html`<div class="hint err">${this.error}</div>`;
    return html`
      <div class="city-container">
        <canvas class="city-canvas" role="img" aria-label="Code city visualization — file activity as 3D buildings"></canvas>
        ${this.loading ? html`<div class="city-loading">updating...</div>` : nothing}
        ${this.tooltipText ? html`<div class="city-tooltip" style="left:${this.tooltipX + 12}px;top:${this.tooltipY - 8}px">${this.tooltipText}</div>` : nothing}
        <div class="city-controls">
          <span class="time-label">${formatDate(this.currentSince)}</span>
          <input
            type="range"
            class="time-slider"
            aria-label="Filter activity since date"
            min=${this.timeRange[0]}
            max=${this.timeRange[1]}
            .value=${String(this.currentSince)}
            @input=${this.onTimeChange}
          />
          <span class="time-label">now</span>
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
      padding: 4px 8px;
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      pointer-events: none;
      white-space: nowrap;
      z-index: 10;
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
      min-width: 80px;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .hint,
    .err {
      padding: var(--space-5);
      opacity: 0.55;
      margin: 0;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .err {
      color: var(--danger);
      opacity: 1;
    }
  `;
}
