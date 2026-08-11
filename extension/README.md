# Flow QC Extension

Chrome MV3 side panel for Record & Playback. Talks to WorkBench `/api/qc/*`.

## Setup

```bash
cd extension
npm install
npm run build
```

Chrome → Extensions → Load unpacked → select `extension/dist`.

## Usage

1. Side panel: Login (username/password — cùng account web). API trỏ cố định `http://127.0.0.1:8787` như FE proxy.
2. Tạo QC project trên web `/qc` nếu chưa có, rồi chọn trong side panel.
3. Mở tab app cần test → Record / Play.

See [docs/QC_ARCHITECTURE.md](../docs/QC_ARCHITECTURE.md).
