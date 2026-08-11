import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Flow QC Automation",
  description: "Record & playback QC flows for complex HR web UIs",
  version: "0.1.0",
  permissions: ["storage", "scripting", "activeTab", "tabs", "sidePanel"],
  host_permissions: ["<all_urls>", "http://127.0.0.1/*", "http://localhost/*"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/ui/sidepanel.html",
  },
  action: {
    default_title: "Flow QC",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  web_accessible_resources: [
    {
      resources: ["src/injected/dialog-bypass.ts"],
      matches: ["<all_urls>"],
    },
  ],
});
