# Graph Report - flow_auto_work  (2026-08-09)

## Corpus Check
- 201 files · ~106,785 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1654 nodes · 4060 edges · 98 communities (86 shown, 12 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.61)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7f0d52a0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- lifecycle.ts
- Google Auth Integration
- commits.ts
- Job Diff UI
- agent/run.ts
- dependencies
- http.ts
- .executeJob
- git/diff.ts
- auth/index.ts
- logger.ts
- Project Settings UI
- Task List UI
- project/index.ts
- job-store.ts
- store.ts
- me/index.ts
- gitlab/client.ts
- Agent Console UI
- Login View
- devDependencies
- compilerOptions
- Google Auth UI
- devDependencies
- workspaceAuth.ts
- getProject
- TypeScript Base Config
- compilerOptions
- extension/package.json
- listAssignedOpenIssues
- ui/App.vue
- Folder Picker UI
- Main App Layout
- compilerOptions
- Handoff View
- QcView.vue
- scripts
- context-quality.ts
- Labels Settings UI
- qc/index.ts
- mongo.ts
- Status Constants
- Metadata API
- Chat Formatting
- Task Scanning CLI
- Task Preview Modal
- Frontend State Stores
- getConfig
- commit.ts
- job/diff.ts
- Realtime Client
- Cursor Settings UI
- Stats Dashboard
- scripts/seed.ts
- git
- applyIssueActions
- Diff Parsing
- MobileBottomNav.vue
- queue.ts
- Local Settings Storage
- App Entry Point
- Issue Link Component
- Pane Layout Hook
- Chat Message UI
- Workbench Keyboard Shortcuts
- Session Store
- AccountSettings.vue
- Work View Layout
- QC Automation Extension — PRD (adapted)
- job/index.ts
- Stop Scripts
- Settings Layout
- Auth Store
- Web TypeScript Config
- Start Scripts
- Vite Environment Types
- Context Samples
- GitLab Templates
- playback.ts
- GitLab API Docs
- GitLab CI Config
- background/index.ts
- record.ts
- prep.ts
- api.ts
- runtime.ts
- package.json
- meRoutes.ts
- exec.ts
- Flow Auto WorkBench — Web UI (Vue 3)
- faker-expand.ts

## God Nodes (most connected - your core abstractions)
1. `getConfig()` - 55 edges
2. `saveJob()` - 47 edges
3. `getRuntimeContext()` - 43 edges
4. `git()` - 40 edges
5. `logger` - 39 edges
6. `JobQueue` - 39 edges
7. `connectMongo()` - 32 edges
8. `requireJobDoc()` - 30 edges
9. `JobRecord` - 25 edges
10. `gitlabFetch()` - 24 edges

## Surprising Connections (you probably didn't know these)
- `applyGlobalMiddleware()` --references--> `express`  [EXTRACTED]
  src/api/middleware/security.ts → package.json
- `officeBytesToCsv()` --references--> `xlsx`  [EXTRACTED]
  src/plugins/google/sheets.ts → package.json
- `main()` --calls--> `getConfig()`  [EXTRACTED]
  scripts/seed.ts → src/config.ts
- `main()` --calls--> `connectMongo()`  [EXTRACTED]
  scripts/seed.ts → src/db/mongo.ts
- `postAgentGitlabComments()` --indirect_call--> `body()`  [INFERRED]
  src/plugins/gitlab/agent-comment.ts → src/api/controllers/jobController.ts

## Import Cycles
- 3-file cycle: `src/modules/job/commit.ts -> src/modules/job/lifecycle.ts -> src/queue.ts -> src/modules/job/commit.ts`

## Communities (98 total, 12 thin omitted)

### Community 0 - "lifecycle.ts"
Cohesion: 0.11
Nodes (37): body(), deleteJobDoc(), listChatMessages(), saveJob(), addJobNote(), appendJobChat(), askJobQuestion(), continueJobChat() (+29 more)

### Community 1 - "Google Auth Integration"
Cohesion: 0.07
Nodes (59): googleController, jobController, routePath, routePath, collectJobSheetRefs(), continueJobAfterGoogleAuth(), detectJobGoogleSheets(), escapeHtml() (+51 more)

### Community 2 - "commits.ts"
Cohesion: 0.21
Nodes (16): revertJobCommit(), collectCommitActions(), fileActionContent(), isBinaryBuffer(), syncLocalToRemoteCommit(), gitStdout(), gitOk(), revertCommitViaGitlab() (+8 more)

### Community 3 - "Job Diff UI"
Cohesion: 0.05
Nodes (49): activeCommit, activePath, blocks, bodyEl, buildGroupDefaults(), closeModal(), commitMessage, commitMode (+41 more)

### Community 4 - "agent/run.ts"
Cohesion: 0.06
Nodes (69): eventsController, setupSse(), SseClient, SseSetupOptions, resolveMergeConflictsWithAi(), appendPromptSending(), appendSdkMessage(), buffers (+61 more)

### Community 5 - "dependencies"
Cohesion: 0.10
Nodes (21): cors, @cursor/sdk, dotenv, express, express-rate-limit, helmet, mongodb, morgan (+13 more)

### Community 6 - "http.ts"
Cohesion: 0.08
Nodes (45): authApi, AuthTokensResponse, api(), applyAuthTokens(), clearSession(), loadSession(), refreshAccessToken(), saveSession() (+37 more)

### Community 7 - ".executeJob"
Cohesion: 0.19
Nodes (15): addChatMessage(), resolveCommitMode(), toContextQualityMark(), appendJobProgress(), extractChatBodyFromAgentText(), clearJobKillRequested(), hasActiveAgentRun(), isStartupError() (+7 more)

### Community 8 - "git/diff.ts"
Cohesion: 0.25
Nodes (20): getJobCommits(), buildFileStats(), DiffFileStat, DiffPayload, emptyTreeSha(), execFileAsync, getReviewDiff(), getWorkingTreeDiff() (+12 more)

### Community 9 - "auth/index.ts"
Cohesion: 0.10
Nodes (34): authController, routePath, hashPassword(), scryptAsync, verifyPassword(), col(), consumeRefreshSession(), RefreshSessionDoc (+26 more)

### Community 10 - "logger.ts"
Cohesion: 0.18
Nodes (13): globalErrorHandler(), applyGlobalMiddleware(), createRouterFromPath(), normalizeMount(), processRoutePath(), resolveCreate(), RouteModule, createApiRouter() (+5 more)

### Community 11 - "Project Settings UI"
Cohesion: 0.08
Nodes (22): branches, cloningId, columns, editId, editOriginalName, form, gitlabProjects, loading (+14 more)

### Community 12 - "Task List UI"
Cohesion: 0.10
Nodes (25): clampJobsHeight(), contextQualityShort(), emit, flashIds, jobDisplayIid(), jobLabels(), jobMilestone(), jobsDragging (+17 more)

### Community 13 - "project/index.ts"
Cohesion: 0.23
Nodes (23): activateUserProject(), asAppError(), CloneProjectBody, createProject(), CreateProjectBody, execFileAsync, getDefaultProjectPath(), getProjectCloneStatus() (+15 more)

### Community 14 - "job-store.ts"
Cohesion: 0.16
Nodes (23): getJobDocByIssue(), applyJobOwnership(), createAdhocJob(), ensureJob(), listActiveIssueKeys(), loadJob(), loadJobByIssue(), migrateAdhocJobToIssue() (+15 more)

### Community 15 - "store.ts"
Cohesion: 0.17
Nodes (33): encryptSecret(), activateProject(), createUserProject(), deleteUserProject(), getActiveProjectForUser(), getMembership(), getProjectByPath(), listMembershipsForUser() (+25 more)

### Community 16 - "me/index.ts"
Cohesion: 0.24
Nodes (22): clearMyCursorKey(), FALLBACK_MODELS, getMe(), getMyHandoffPrefs(), listCursorModels(), requireUser(), setMyQcRole(), updateMyHandoffPrefs() (+14 more)

### Community 17 - "gitlab/client.ts"
Cohesion: 0.16
Nodes (27): buildIssueComment(), buildMrBody(), buildMrTitle(), createJobMergeRequest(), acceptMergeRequest(), collectRelatedIssuesUi(), createIssue(), createMergeRequest() (+19 more)

### Community 18 - "Agent Console UI"
Cohesion: 0.13
Nodes (21): chatBox, chatScroll, clampProgressHeight(), emit, headerEl, maxProgressHeight(), mobileConsoleTab, onProgressRailPointerDown() (+13 more)

### Community 19 - "Login View"
Cohesion: 0.12
Nodes (18): applyAuthAndGo(), auth, errorText, form, glowActive, glowX, glowY, loading (+10 more)

### Community 20 - "devDependencies"
Cohesion: 0.10
Nodes (21): nodemon, devDependencies, nodemon, tsx, @types/cors, @types/express, @types/helmet, @types/morgan (+13 more)

### Community 21 - "compilerOptions"
Cohesion: 0.10
Nodes (19): ES2023, node, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection (+11 more)

### Community 22 - "Google Auth UI"
Cohesion: 0.14
Nodes (17): autoContinueAfterAuth, awaitingGoogleAuth, continueAfterGoogle(), detectedSheets, emit, googleBusy, googleStatus, includeSaving (+9 more)

### Community 23 - "devDependencies"
Cohesion: 0.04
Nodes (48): @ant-design/icons-vue, ant-design-vue, autoprefixer, axios, marked, pinia, postcss, splitpanes (+40 more)

### Community 24 - "workspaceAuth.ts"
Cohesion: 0.11
Nodes (19): fsController, gitlabController, headerProjectFromExpress(), headerUserFromExpress(), isPublicApiPath(), requireWorkspace(), requireWorkspaceAsync, routePath (+11 more)

### Community 25 - "getProject"
Cohesion: 0.33
Nodes (11): startProjectClone(), buildOauthCloneUrl(), isGitRepo(), pathExists(), runGitClone(), assertProjectCloneReady(), assertRepoPath(), resolveRuntimeContext() (+3 more)

### Community 26 - "TypeScript Base Config"
Cohesion: 0.11
Nodes (17): dist, node_modules, src/**/*, compilerOptions, declaration, esModuleInterop, module, moduleResolution (+9 more)

### Community 27 - "compilerOptions"
Cohesion: 0.11
Nodes (17): src/**/*.tsx, @vue/tsconfig/tsconfig.dom.json, compilerOptions, allowArbitraryExtensions, baseUrl, erasableSyntaxOnly, noFallthroughCasesInSwitch, noUnusedLocals (+9 more)

### Community 28 - "extension/package.json"
Cohesion: 0.07
Nodes (26): @crxjs/vite-plugin, dependencies, @faker-js/faker, vue, devDependencies, @crxjs/vite-plugin, @types/chrome, typescript (+18 more)

### Community 29 - "listAssignedOpenIssues"
Cohesion: 0.23
Nodes (12): taskController, routePath, getTaskDetail(), listTasks(), updateTasks(), UpdateTasksInput, getIssueUiDetail(), listAssignedOpenIssues() (+4 more)

### Community 30 - "ui/App.vue"
Cohesion: 0.11
Nodes (25): ExtConfig, activeTabId(), buildPlanFromTestCase(), busy, cfg, error, expandSteps(), flowName (+17 more)

### Community 31 - "Folder Picker UI"
Cohesion: 0.17
Nodes (14): confirm(), currentPath, emit, enter(), entries, goHome(), goParent(), home (+6 more)

### Community 32 - "Main App Layout"
Cohesion: 0.13
Nodes (11): activeProject, idleDot, nav, projectOptions, route, router, selectedProjectId, session (+3 more)

### Community 33 - "compilerOptions"
Cohesion: 0.08
Nodes (23): compilerOptions, isolatedModules, jsx, lib, module, moduleResolution, noEmit, resolveJsonModule (+15 more)

### Community 34 - "Handoff View"
Cohesion: 0.14
Nodes (11): addLabels, assignee, busy, comment, handoffJobs, { jobs, members, labels }, selected, selectedId (+3 more)

### Community 35 - "QcView.vue"
Cohesion: 0.13
Nodes (20): createFlow(), createProject(), createTestCase(), flowForm, flows, loading, loadProjects(), loadScoped() (+12 more)

### Community 36 - "scripts"
Cohesion: 0.11
Nodes (19): scripts, build:extension, build:web, dev, dev:all, dev:extension, dev:web, install:extension (+11 more)

### Community 37 - "context-quality.ts"
Cohesion: 0.18
Nodes (14): assessContextQuality(), CONTEXT_QUALITY_STANDARDS, ContextQualityInput, ContextQualityLevel, ContextQualityMark, ContextQualityResult, formatBadContextChatMessage(), formatContextQualityForPrompt() (+6 more)

### Community 38 - "Labels Settings UI"
Cohesion: 0.15
Nodes (11): addLabels, assignee, comment, { local }, onStartLabels, processingLabel, removeLabels, saving (+3 more)

### Community 39 - "qc/index.ts"
Cohesion: 0.08
Nodes (51): notesController, qcController, qcProjectId(), username(), qcAls, QcRequestContext, requireQc, requireQcContext() (+43 more)

### Community 40 - "mongo.ts"
Cohesion: 0.15
Nodes (16): statsController, routePath, buildMongoUri(), addNote(), chat(), ChatMessageDoc, deleteJobSideDocs(), getJobDoc() (+8 more)

### Community 41 - "Status Constants"
Cohesion: 0.18
Nodes (8): CONTEXT_QUALITY_LABELS, CONTEXT_QUALITY_STANDARDS, contextQualityLabel(), ContextQualityLevel, MANUAL_JOB_STATUSES, ManualJobStatus, STATUS_LABELS, statusLabel()

### Community 42 - "Metadata API"
Cohesion: 0.29
Nodes (7): metaController, routePath, getCompletionDefaults(), listLabels(), listMembers(), listProjectLabels(), listProjectMembers()

### Community 43 - "Chat Formatting"
Cohesion: 0.38
Nodes (10): absolutizeUploadPath(), cleanAgentChatBody(), cleanMarkdownBody(), escapeHtml(), gitlabProjectBase(), renderChatHtml(), rewriteUploadHtml(), rewriteUploadMarkdown() (+2 more)

### Community 44 - "Task Scanning CLI"
Cohesion: 0.38
Nodes (8): ensureFullConfigForGitlabApi(), listOnly(), scanAndEnqueue(), withCliRuntime(), assertNotPlaceholder(), getGitlabScanConfig(), schema, runWithRuntimeContext()

### Community 45 - "Task Preview Modal"
Cohesion: 0.20
Nodes (9): emit, humanComments, iid, meta, openProxy, props, session, title (+1 more)

### Community 46 - "Frontend State Stores"
Cohesion: 0.22
Nodes (7): useSettingsStore, Job, RelatedIssue, Task, TaskDetail, TaskNote, useWorkStore

### Community 47 - "getConfig"
Cohesion: 0.20
Nodes (13): AppConfig, envSchema, getConfig(), getDiffPayload(), proxyGitlabUpload(), ProxyUploadOpts, fetchGitlabIdentityFromToken(), GitlabIdentity (+5 more)

### Community 48 - "commit.ts"
Cohesion: 0.27
Nodes (17): assertSafeRepoPath(), buildCommitMessage(), commitJobManual(), CommitMode, discardJobChanges(), FinalizeCommitResult, finalizeGitlabCommitForJob(), groupJobCommits() (+9 more)

### Community 49 - "job/diff.ts"
Cohesion: 0.20
Nodes (15): approveJobDiff(), getJobDiff(), readJobFile(), writeJobFile(), extractPathsFromUnifiedDiff(), readRepoFile(), resolveSafePath(), writeRepoFile() (+7 more)

### Community 50 - "Realtime Client"
Cohesion: 0.25
Nodes (8): connectRealtime(), Handlers, RealtimeChat, RealtimeChatMessage, RealtimeJob, RealtimeJobs, RealtimeProgress, RealtimeStatus

### Community 51 - "Cursor Settings UI"
Cohesion: 0.22
Nodes (5): cursorKey, loading, model, models, session

### Community 52 - "Stats Dashboard"
Cohesion: 0.22
Nodes (7): daily, DayBucket, DayItem, loading, ProjectTokens, tokens, TokensSummary

### Community 53 - "scripts/seed.ts"
Cohesion: 0.26
Nodes (14): main(), ensureAuthIndexes(), closeMongo(), main(), assignJobsToDefaultWorkspace(), failInterruptedJobs(), resolveLegacyDiffApprovalJobs(), startHttpServer() (+6 more)

### Community 54 - "git"
Cohesion: 0.34
Nodes (15): git(), abortMerge(), attemptMergeIntoBase(), branchExists(), finalizeMergeCommit(), findStashRef(), getCurrentBranch(), hasDirtyWorktree() (+7 more)

### Community 55 - "applyIssueActions"
Cohesion: 0.43
Nodes (7): applyCompletionActions(), applyIssueActions(), applyIssueCompletionActions(), clearIssueProcessing(), markIssueProcessing(), processingLabel(), resolveProcessingLabel()

### Community 56 - "Diff Parsing"
Cohesion: 0.32
Nodes (7): buildDiffBlocks(), DiffBlock, DiffFileStat, DiffRow, parseDiffRows(), parseHunkHeader(), splitUnifiedDiff()

### Community 57 - "MobileBottomNav.vue"
Cohesion: 0.25
Nodes (5): activePath, route, router, session, tabs

### Community 58 - "queue.ts"
Cohesion: 0.16
Nodes (16): getJobDocsForReview(), docsCommitMessageForIssue(), formatChatContextForRun(), docsReadySummaryText(), normalizeDocsRelPath(), parseDocsReadyPaths(), readRepoDoc(), readRepoDocs() (+8 more)

### Community 59 - "Local Settings Storage"
Cohesion: 0.53
Nodes (5): consumeLegacyLocalSettings(), defaultHandoffPrefs(), isHandoffPrefsEmpty(), LocalSettings, normalizeHandoffPrefs()

### Community 60 - "App Entry Point"
Cohesion: 0.40
Nodes (3): themeConfig, app, router

### Community 61 - "Issue Link Component"
Cohesion: 0.33
Nodes (5): href, label, { memberships, projectId }, props, session

### Community 62 - "Pane Layout Hook"
Cohesion: 0.50
Nodes (4): DEFAULT, load(), PaneState, usePaneLayout()

### Community 63 - "Chat Message UI"
Cohesion: 0.50
Nodes (3): html, props, useMarkdown

### Community 65 - "Session Store"
Cohesion: 0.50
Nodes (3): Membership, UserPublic, useSessionStore

### Community 66 - "AccountSettings.vue"
Cohesion: 0.29
Nodes (4): isQc, qcBusy, router, session

### Community 68 - "QC Automation Extension — PRD (adapted)"
Cohesion: 0.08
Nodes (23): Deployment Guide, Development Notes, API (`/api/qc`), Auth gate, Components, Message protocol, Mongo collections, QC Architecture (+15 more)

### Community 69 - "job/index.ts"
Cohesion: 0.23
Nodes (13): listJobs(), listJobsForUi(), ListJobsQuery, normalizeCompletion(), startJobs(), StartJobsInput, ensureJobForIssue(), findJobByIssueIid() (+5 more)

### Community 81 - "playback.ts"
Cohesion: 0.25
Nodes (12): assignFile(), executeStep(), fetchSampleAsFile(), setNativeValue(), buildPrimarySelector(), cssEscape(), extractSelectorContext(), findByContext() (+4 more)

### Community 86 - "background/index.ts"
Cohesion: 0.28
Nodes (9): advancePlayback(), defaultState(), getState(), sendStep(), setState(), ExtMessage, ExecutionState, QcStep (+1 more)

### Community 87 - "record.ts"
Cohesion: 0.28
Nodes (11): playEnv, injectDialogBypass(), PlaybackEnv, beginRecord(), clearRecordedSteps(), endRecord(), getRecordedSteps(), interestingTarget() (+3 more)

### Community 88 - "prep.ts"
Cohesion: 0.29
Nodes (11): autoWorkBranchName(), slugifyIssueTitle(), branchExists(), checkoutBranch(), createBranchFromBase(), forcePushBranch(), PreparedRepo, prepareRepoForIssue() (+3 more)

### Community 89 - "api.ts"
Cohesion: 0.32
Nodes (11): getFlow(), listFlows(), listProjects(), listTestCases(), loadConfig(), qcFetch(), saveConfig(), saveFlow() (+3 more)

### Community 90 - "runtime.ts"
Cohesion: 0.24
Nodes (6): statusController, routePath, mongoPing(), getStatusPayload(), als, RuntimeContext

### Community 91 - "package.json"
Cohesion: 0.25
Nodes (7): description, engines, node, name, private, type, version

### Community 92 - "meRoutes.ts"
Cohesion: 0.25
Nodes (4): meController, projectController, routePath, routePath

### Community 93 - "exec.ts"
Cohesion: 0.50
Nodes (4): execFileAsync, gitExecEnv(), GitIdentity, resolveGitIdentity()

### Community 94 - "Flow Auto WorkBench — Web UI (Vue 3)"
Cohesion: 0.40
Nodes (4): Dev, Flow Auto WorkBench — Web UI (Vue 3), Production build, Routes

### Community 95 - "faker-expand.ts"
Cohesion: 0.83
Nodes (3): callFakerPath(), expandStepValue(), expandTemplate()

## Knowledge Gaps
- **522 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+517 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getConfig()` connect `getConfig` to `Google Auth Integration`, `commits.ts`, `agent/run.ts`, `job/index.ts`, `qc/index.ts`, `mongo.ts`, `auth/index.ts`, `logger.ts`, `Metadata API`, `.executeJob`, `store.ts`, `gitlab/client.ts`, `job/diff.ts`, `scripts/seed.ts`, `prep.ts`, `queue.ts`, `listAssignedOpenIssues`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Why does `applyGlobalMiddleware()` connect `logger.ts` to `dependencies`, `getConfig`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _522 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `lifecycle.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10852713178294573 - nodes in this community are weakly interconnected._
- **Should `Google Auth Integration` be split into smaller, more focused modules?**
  _Cohesion score 0.06625258799171843 - nodes in this community are weakly interconnected._
- **Should `Job Diff UI` be split into smaller, more focused modules?**
  _Cohesion score 0.052525252525252523 - nodes in this community are weakly interconnected._