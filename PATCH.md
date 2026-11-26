# 本地补丁说明（patch2）

本分支在官方 `songloft-org/songloft-plugin-miot` 基础上打了本地补丁，解决上游
issue #130 的行为：语音点播一首不在歌单里的歌（或点播某位歌手的歌）时，官方版
只建 1 首歌的临时队列，播完就停，续播只从本地曲库找歌——只用在线音源（洛雪）
的用户曲库里同歌手往往只有命中的那一首，于是永远「播一首就停」。

补丁版本：`2026.11.26.0-patch2`（基于官方 2026.11.26.0，基线提交 e67b0e8）

## 改动

1. **首轮补歌**（`src/player/manager.ts`、`src/music/service.ts`、
   `src/voicecmd/online_searcher.ts`）
   独立歌曲建临时歌手队列时，若队列不足 8 首、歌手已知、非电台、且播放模式
   不是单曲/单曲循环，就按歌手向洛雪列表搜索（`POST /api/search`，逐平台逐页）
   补歌并导入曲库，把队列补到约 15 首。补歌经宿主 `/api/v1/songs/remote` 入库，
   按 id 与「歌名|歌手」双重去重；每轮必打 `[StandaloneTopup]` 日志（含补到
   0 首的原因）。

2. **接续补歌**（同上文件）
   临时歌手队列在顺序播放下播到最后一首时，后台自动再补一批同歌手新歌追加到
   队尾；播完仍无下一首时还有一道兜底补歌。一批接一批，直到洛雪目录翻不出
   新歌才自然结束。插件重启恢复临时队列后接续能力自动重连。

3. **防自动更新覆盖**（`plugin.json`、`package.json`）
   删除 `plugin.json` 的 `updateUrl`。教训：patch1 于 2026-11-26 19:59 部署后，
   20:04 被宿主按 updateUrl 发起的更新检查冲回官方版，补丁无声失效。删掉后
   宿主没有自动更新通道。**不要在 Songloft 里手动更新/重装这个插件**，会冲掉
   补丁；上游出了想跟的新版时，先在本仓库把补丁重新应用到新基线再部署。

## 注意

- 设备播放模式必须是「顺序播放」：小爱音箱Pro 曾持久化为单曲模式（play_mode
  =single），单曲语义下补丁按设计不补歌。
- 构建与验证：`npx tsc --noEmit`、`node --experimental-strip-types --test tests/*.test.mjs`、
  `npm run build`、`npm run validate`。测试基线：1445 个中 21 个既有环境失败，
  打补丁前后失败集合一致。
- 部署：把 `dist/miot.jsplugin.zip` 放到 NAS 的
  `/vol1/@appshare/songloft/data/jsplugins/` 后 `docker restart songloft`。
  回滚：用同目录的 `miot.jsplugin.zip.bak-official-20261126`（官方版）覆盖回去
  再重启。
- 实测（2026-11-26）：语音「我想听任**的歌」→ 首轮补歌 +14 首（队列 15 首），
  自动接播下一首通过。
