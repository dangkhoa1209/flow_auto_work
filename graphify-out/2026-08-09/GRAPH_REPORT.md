# Graph Report - .  (2026-08-08)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1391 nodes · 3583 edges · 83 communities (69 shown, 14 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.62)
- Token cost: 3,022 input · 897 output

## Graph Freshness
- Built from commit: `59a37897`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- MongoDB Job Storage
- Google Auth Integration
- Git Commit Management
- Job Diff UI
- AI Merge Resolution
- Backend Dependencies
- Auth API Client
- Job Queue Logic
- Git Diff Utilities
- Authentication Controller
- App Configuration
- Project Settings UI
- Task List UI
- Project Management API
- AI Prompt Engineering
- Database Seeding
- User Profile API
- GitLab API Client
- Agent Console UI
- Login View
- Dev Dependencies
- Vite Node Config
- Google Auth UI
- Frontend Build Tools
- File System API
- Project Cloning Logic
- TypeScript Base Config
- TypeScript App Config
- Frontend Dependencies
- Task Management API
- Folder Picker UI
- Main App Layout
- Server-Sent Events
- Handoff View
- GitLab Workspace Auth
- Context Quality Assessment
- Labels Settings UI
- Notes API
- Stats and Status API
- Status Constants
- Metadata API
- Chat Formatting
- Task Scanning CLI
- Task Preview Modal
- Frontend State Stores
- GitLab Upload Proxy
- Merge Request Creation
- Web Package Config
- Realtime Client
- Cursor Settings UI
- Stats Dashboard
- Route Processing
- Issue Action Logic
- Diff Parsing
- Mobile Navigation
- AI Comment Processing
- Local Settings Storage
- App Entry Point
- Issue Link Component
- Pane Layout Hook
- Chat Message UI
- Workbench Keyboard Shortcuts
- Session Store
- Account Settings UI
- Work View Layout
- Project Documentation
- Node Type Definitions
- Stop Scripts
- Settings Layout
- Auth Store
- Web TypeScript Config
- Start Scripts
- Vite Environment Types
- Context Samples
- GitLab Templates
- Project Roadmap
- GitLab API Docs
- GitLab CI Config

## God Nodes (most connected - your core abstractions)
1. `getConfig()` - 55 edges
2. `saveJob()` - 47 edges
3. `getRuntimeContext()` - 43 edges
4. `git()` - 40 edges
5. `logger` - 39 edges
6. `JobQueue` - 39 edges
7. `requireJobDoc()` - 30 edges
8. `connectMongo()` - 26 edges
9. `JobRecord` - 25 edges
10. `gitlabFetch()` - 24 edges

## Surprising Connections (you probably didn't know these)
- `applyGlobalMiddleware()` --references--> `express`  [EXTRACTED]
  src/api/middleware/security.ts → package.json
- `officeBytesToCsv()` --references--> `xlsx`  [EXTRACTED]
  src/plugins/google/sheets.ts → package.json
- `main()` --calls--> `ensureAuthIndexes()`  [EXTRACTED]
  scripts/seed.ts → src/auth/sessions.ts
- `main()` --calls--> `getConfig()`  [EXTRACTED]
  scripts/seed.ts → src/config.ts
- `main()` --calls--> `connectMongo()`  [EXTRACTED]
  scripts/seed.ts → src/db/mongo.ts

## Import Cycles
- 3-file cycle: `src/modules/job/commit.ts -> src/modules/job/lifecycle.ts -> src/queue.ts -> src/modules/job/commit.ts`

## Communities (83 total, 14 thin omitted)

### Community 0 - "MongoDB Job Storage"
Cohesion: 0.05
Nodes (102): buildMongoUri(), addNote(), chat(), ChatMessageDoc, connectMongo(), deleteJobDoc(), deleteJobSideDocs(), getJobDoc() (+94 more)

### Community 1 - "Google Auth Integration"
Cohesion: 0.07
Nodes (59): googleController, jobController, routePath, routePath, collectJobSheetRefs(), continueJobAfterGoogleAuth(), detectJobGoogleSheets(), escapeHtml() (+51 more)

### Community 2 - "Git Commit Management"
Cohesion: 0.09
Nodes (61): assertSafeRepoPath(), buildCommitMessage(), commitJobManual(), CommitMode, discardJobChanges(), FinalizeCommitResult, finalizeGitlabCommitForJob(), groupJobCommits() (+53 more)

### Community 3 - "Job Diff UI"
Cohesion: 0.05
Nodes (49): activeCommit, activePath, blocks, bodyEl, buildGroupDefaults(), closeModal(), commitMessage, commitMode (+41 more)

### Community 4 - "AI Merge Resolution"
Cohesion: 0.11
Nodes (41): resolveMergeConflictsWithAi(), appendJobProgress(), appendPromptSending(), appendSdkMessage(), buffers, clearJobProgress(), JobTokenSnapshot, ProgressLine (+33 more)

### Community 5 - "Backend Dependencies"
Cohesion: 0.04
Nodes (44): cors, Cursor SDK, dotenv, express, express-rate-limit, helmet, mongodb, morgan (+36 more)

### Community 6 - "Auth API Client"
Cohesion: 0.12
Nodes (35): authApi, AuthTokensResponse, api(), applyAuthTokens(), clearSession(), loadSession(), refreshAccessToken(), saveSession() (+27 more)

### Community 7 - "Job Queue Logic"
Cohesion: 0.19
Nodes (13): addChatMessage(), formatContextQualityForPrompt(), toContextQualityMark(), extractChatBodyFromAgentText(), clearJobKillRequested(), hasActiveAgentRun(), isStartupError(), isTransientCursorTransportError() (+5 more)

### Community 8 - "Git Diff Utilities"
Cohesion: 0.13
Nodes (35): resolveCommitMode(), getJobCommits(), getJobDiff(), readJobFile(), writeJobFile(), buildFileStats(), DiffFileStat, DiffPayload (+27 more)

### Community 9 - "Authentication Controller"
Cohesion: 0.10
Nodes (34): authController, routePath, hashPassword(), scryptAsync, verifyPassword(), col(), consumeRefreshSession(), ensureAuthIndexes() (+26 more)

### Community 10 - "App Configuration"
Cohesion: 0.13
Nodes (18): globalErrorHandler(), applyGlobalMiddleware(), createApiRouter(), createApp(), AppConfig, envSchema, getConfig(), Level (+10 more)

### Community 11 - "Project Settings UI"
Cohesion: 0.08
Nodes (22): branches, cloningId, columns, editId, editOriginalName, form, gitlabProjects, loading (+14 more)

### Community 12 - "Task List UI"
Cohesion: 0.10
Nodes (25): clampJobsHeight(), contextQualityShort(), emit, flashIds, jobDisplayIid(), jobLabels(), jobMilestone(), jobsDragging (+17 more)

### Community 13 - "Project Management API"
Cohesion: 0.18
Nodes (27): projectController, routePath, activateUserProject(), asAppError(), CloneProjectBody, createProject(), CreateProjectBody, execFileAsync (+19 more)

### Community 14 - "AI Prompt Engineering"
Cohesion: 0.18
Nodes (22): buildDocsPhasePrompt(), buildFollowUpPrompt(), buildResumePrompt(), buildWorkPrompt(), clarifyBudgetLine(), docsCommitMessageForIssue(), formatChatContextForRun(), gitlabCommentInstructions() (+14 more)

### Community 15 - "Database Seeding"
Cohesion: 0.14
Nodes (34): main(), closeMongo(), assignJobsToDefaultWorkspace(), encryptSecret(), ensureWorkspaceSeed(), SEED_PASSWORD, SEED_PROJECT, SEED_USERNAME (+26 more)

### Community 16 - "User Profile API"
Cohesion: 0.20
Nodes (23): meController, routePath, clearMyCursorKey(), FALLBACK_MODELS, getMe(), getMyHandoffPrefs(), listCursorModels(), requireUser() (+15 more)

### Community 17 - "GitLab API Client"
Cohesion: 0.18
Nodes (22): acceptMergeRequest(), collectRelatedIssuesUi(), createIssue(), extractTaskListIids(), fetchIssueAsJob(), getMergeRequest(), gitlabFetch(), GitlabIssueApi (+14 more)

### Community 18 - "Agent Console UI"
Cohesion: 0.13
Nodes (21): chatBox, chatScroll, clampProgressHeight(), emit, headerEl, maxProgressHeight(), mobileConsoleTab, onProgressRailPointerDown() (+13 more)

### Community 19 - "Login View"
Cohesion: 0.12
Nodes (18): applyAuthAndGo(), auth, errorText, form, glowActive, glowX, glowY, loading (+10 more)

### Community 20 - "Dev Dependencies"
Cohesion: 0.10
Nodes (20): nodemon, devDependencies, nodemon, tsx, @types/cors, @types/express, @types/helmet, @types/morgan (+12 more)

### Community 21 - "Vite Node Config"
Cohesion: 0.10
Nodes (19): ES2023, node, vite.config.ts, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module (+11 more)

### Community 22 - "Google Auth UI"
Cohesion: 0.14
Nodes (17): autoContinueAfterAuth, awaitingGoogleAuth, continueAfterGoogle(), detectedSheets, emit, googleBusy, googleStatus, includeSaving (+9 more)

### Community 23 - "Frontend Build Tools"
Cohesion: 0.11
Nodes (19): autoprefixer, postcss, tailwindcss, @tailwindcss/forms, @types/marked, vite, @vitejs/plugin-vue, vue-tsc (+11 more)

### Community 24 - "File System API"
Cohesion: 0.15
Nodes (10): fsController, routePath, routePath, browseFs, browseLocalPath(), getWorkspaceContext(), browseDirectory(), BrowseResult (+2 more)

### Community 25 - "Project Cloning Logic"
Cohesion: 0.24
Nodes (15): isGitRepo(), pathExists(), runGitClone(), assertProjectCloneReady(), assertRepoPath(), resolveRuntimeContext(), RuntimeContext, getMembership() (+7 more)

### Community 26 - "TypeScript Base Config"
Cohesion: 0.11
Nodes (17): dist, node_modules, src/**/*, compilerOptions, declaration, esModuleInterop, module, moduleResolution (+9 more)

### Community 27 - "TypeScript App Config"
Cohesion: 0.11
Nodes (17): src/**/*.ts, src/**/*.tsx, src/**/*.vue, vite/client, @vue/tsconfig/tsconfig.dom.json, compilerOptions, allowArbitraryExtensions, baseUrl (+9 more)

### Community 28 - "Frontend Dependencies"
Cohesion: 0.12
Nodes (17): @ant-design/icons-vue, ant-design-vue, axios, marked, pinia, splitpanes, vue, vue-router (+9 more)

### Community 29 - "Task Management API"
Cohesion: 0.24
Nodes (11): taskController, routePath, getTaskDetail(), listTasks(), updateTasks(), UpdateTasksInput, getIssueUiDetail(), listAssignedOpenIssues() (+3 more)

### Community 31 - "Folder Picker UI"
Cohesion: 0.17
Nodes (14): confirm(), currentPath, emit, enter(), entries, goHome(), goParent(), home (+6 more)

### Community 32 - "Main App Layout"
Cohesion: 0.13
Nodes (11): activeProject, idleDot, nav, projectOptions, route, router, selectedProjectId, session (+3 more)

### Community 33 - "Server-Sent Events"
Cohesion: 0.16
Nodes (10): eventsController, setupSse(), SseClient, SseSetupOptions, ChatMessageEvent, Listener, listeners, ProgressLineEvent (+2 more)

### Community 34 - "Handoff View"
Cohesion: 0.14
Nodes (11): addLabels, assignee, busy, comment, handoffJobs, { jobs, members, labels }, selected, selectedId (+3 more)

### Community 36 - "GitLab Workspace Auth"
Cohesion: 0.26
Nodes (9): gitlabController, headerProjectFromExpress(), headerUserFromExpress(), isPublicApiPath(), requireWorkspace(), requireWorkspaceAsync, routePath, verifyAccessToken() (+1 more)

### Community 37 - "Context Quality Assessment"
Cohesion: 0.22
Nodes (12): assessContextQuality(), CONTEXT_QUALITY_STANDARDS, ContextQualityInput, ContextQualityLevel, ContextQualityMark, ContextQualityResult, formatBadContextChatMessage(), matchAll() (+4 more)

### Community 38 - "Labels Settings UI"
Cohesion: 0.15
Nodes (11): addLabels, assignee, comment, { local }, onStartLabels, processingLabel, removeLabels, saving (+3 more)

### Community 39 - "Notes API"
Cohesion: 0.24
Nodes (5): notesController, routePath, createNote(), listNotesForUi(), AppError

### Community 40 - "Stats and Status API"
Cohesion: 0.23
Nodes (5): statsController, statusController, routePath, routePath, asyncHandler()

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

### Community 47 - "GitLab Upload Proxy"
Cohesion: 0.42
Nodes (7): proxyGitlabUpload(), ProxyUploadOpts, fetchGitlabProject(), assertGitlabUploadHost(), fetchGitlabUpload(), parseUploadPath(), uploadAuthHeaders()

### Community 48 - "Merge Request Creation"
Cohesion: 0.44
Nodes (8): buildIssueComment(), buildMrBody(), buildMrTitle(), createJobMergeRequest(), createMergeRequest(), findOpenMergeRequest(), getProjectDefaultBranch(), projectApiKey()

### Community 49 - "Web Package Config"
Cohesion: 0.22
Nodes (8): name, private, scripts, build, dev, preview, type, version

### Community 50 - "Realtime Client"
Cohesion: 0.25
Nodes (8): connectRealtime(), Handlers, RealtimeChat, RealtimeChatMessage, RealtimeJob, RealtimeJobs, RealtimeProgress, RealtimeStatus

### Community 51 - "Cursor Settings UI"
Cohesion: 0.22
Nodes (5): cursorKey, loading, model, models, session

### Community 52 - "Stats Dashboard"
Cohesion: 0.22
Nodes (7): daily, DayBucket, DayItem, loading, ProjectTokens, tokens, TokensSummary

### Community 54 - "Route Processing"
Cohesion: 0.39
Nodes (6): createRouterFromPath(), normalizeMount(), processRoutePath(), resolveCreate(), RouteModule, routesDir

### Community 55 - "Issue Action Logic"
Cohesion: 0.43
Nodes (7): applyIssueActions(), applyIssueCompletionActions(), commentOnIssue(), clearIssueProcessing(), markIssueProcessing(), processingLabel(), resolveProcessingLabel()

### Community 56 - "Diff Parsing"
Cohesion: 0.32
Nodes (7): buildDiffBlocks(), DiffBlock, DiffFileStat, DiffRow, parseDiffRows(), parseHunkHeader(), splitUnifiedDiff()

### Community 57 - "Mobile Navigation"
Cohesion: 0.29
Nodes (4): activePath, route, router, tabs

### Community 58 - "AI Comment Processing"
Cohesion: 0.47
Nodes (5): body(), AI_GENERATED_MARKER, extractGitlabCommentBodies(), postAgentGitlabComments(), withAiGeneratedMarker()

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

### Community 68 - "Project Documentation"
Cohesion: 0.67
Nodes (3): Deployment Guide, Development Notes, Flow Auto WorkBench README

### Community 69 - "Node Type Definitions"
Cohesion: 0.67
Nodes (3): @types/node, @types/node, @types/node

## Knowledge Gaps
- **423 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+418 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getConfig()` connect `App Configuration` to `MongoDB Job Storage`, `Google Auth Integration`, `Git Commit Management`, `Job Queue Logic`, `Git Diff Utilities`, `Authentication Controller`, `Metadata API`, `AI Prompt Engineering`, `Database Seeding`, `Merge Request Creation`, `GitLab API Client`, `GitLab Upload Proxy`, `Task Management API`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Why does `applyGlobalMiddleware()` connect `App Configuration` to `Backend Dependencies`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _423 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `MongoDB Job Storage` be split into smaller, more focused modules?**
  _Cohesion score 0.05238709677419355 - nodes in this community are weakly interconnected._
- **Should `Google Auth Integration` be split into smaller, more focused modules?**
  _Cohesion score 0.06625258799171843 - nodes in this community are weakly interconnected._
- **Should `Git Commit Management` be split into smaller, more focused modules?**
  _Cohesion score 0.08610400682011936 - nodes in this community are weakly interconnected._
- **Should `Job Diff UI` be split into smaller, more focused modules?**
  _Cohesion score 0.052525252525252523 - nodes in this community are weakly interconnected._