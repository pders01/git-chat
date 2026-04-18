// Preloaded by bun test (see bunfig.toml) to give DOM-touching tests
// a working `document`, `window`, and friends. Keep this minimal — the
// DOM helpers we test (splitDiffHtml, highlightWordDiffs) only need
// createElement + innerHTML + querySelector, all of which happy-dom
// handles fine. If a future test needs a richer API, consider adding
// it here rather than in each test file.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
