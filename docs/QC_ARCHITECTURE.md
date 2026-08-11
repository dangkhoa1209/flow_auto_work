# QC Architecture

## Components

```
Side Panel (Vue)  --messages-->  Service Worker (orchestrator)
                                      |
                                      | chrome.tabs.sendMessage
                                      v
                              Content Script (record/play DOM)
                                      |
                                      | inject <script>
                                      v
                              Page world (confirm/alert override)
```

State for in-flight playback lives in **`chrome.storage.session`** only (MV3 SW can sleep). Content scripts must not own playback cursor across reloads.

## Auth gate

| Header / claim | Purpose |
|----------------|---------|
| `Authorization: Bearer` | Same JWT as WorkBench |
| `X-Qc-Project` | QC project id (not GitLab workspace) |
| User `roles` includes `qc` | “I am QC” — else 403 |

`/api/qc` is listed as workspace-public in `workspaceAuth` then protected by `requireQc` on the QC router.

## Message protocol

| From → To | Type | Payload |
|-----------|------|---------|
| UI → BG | `PLAY_PLAN` | `{ tabId, steps[] }` expanded |
| UI → BG | `STOP` | — |
| UI → BG | `START_RECORD` / `STOP_RECORD` | `{ tabId }` |
| BG → CS | `EXECUTE_STEP` | step |
| BG → CS | `BEGIN_RECORD` | — |
| BG → CS | `INJECT_DIALOG_BYPASS` | — |
| CS → BG | `STEP_RESULT` | `{ ok, error? }` |
| CS → BG | `RECORDED_EVENT` | step draft |
| CS → BG | `CONTENT_READY` | — |

On `tabs.onUpdated` (status `complete`), if session has active plan, BG re-sends next `EXECUTE_STEP`.

## Selector context & heal

```ts
type SelectorContext = {
  primarySelector?: string; // #id, [data-test]
  textContent?: string;
  tagName?: string;
  xpath?: string;
};
```

Playback order: text / xpath-with-text → `primarySelector` → fail after wait.

Vue input hack:

```js
el.value = text;
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
```

## Mongo collections

- `qc_projects` — `{ _id, ownerUsername, name, targetBaseUrl, … }`
- `qc_flows` — `{ _id, qcProjectId, name, steps[] }`
- `qc_test_cases` — `{ _id, qcProjectId, name, loopCount, executionPlan[] }`
- `qc_sample_files` — metadata; blobs under `uploads/qc/`

## API (`/api/qc`)

- Projects / flows / test-cases CRUD
- `GET /sample-files/:id` — binary for upload steps
- Faker/loop expand runs in the extension Side Panel (not required on server)
