// MIoT 智能音箱插件 - 在线歌曲搜索器
// 当本地索引找不到歌曲时，调用用户配置的外部搜索 API 搜索并推送到音箱

/// <reference types="@songloft/plugin-sdk" />

import { MinaService } from '../service/service';
import { getHostAPIBaseUrl, getHostBaseUrl } from '../utils/http';
import { URLBuilder, playbackOptionsOf } from '../player/url_builder';
import { ConfigManager } from '../config/manager';
import { IndexingManager } from '../indexing/manager';
import { GroupCoordinator } from '../group/coordinator';
import type { ExternalSearchSource } from '../types';
import type { PlaylistManager } from '../player/manager';

// 外部搜索 API 请求体
interface SearchOneRequest {
  keyword: string;
  hint?: { title?: string; artist?: string; duration?: number };
  quality?: string;
}

// 外部搜索 API 成功响应 data（provider 中立，不解读内部字段）
export interface OnlineSearchResult {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  cover_url?: string;
  url?: string;                                      // 直链型 provider 提供
  plugin_entry_path?: string;                        // provider 自身 entryPath；缺省纯外链
  source_data?: string | Record<string, unknown>;   // 不透明；对象则由 MIoT 序列化
  dedup_key?: string;
  lyric?: string;
  lyric_source?: string;
}

// 外部搜索 API 响应
interface SearchOneResponse {
  code: number;
  msg: string;
  data: OnlineSearchResult | null;
}

// songloft /api/v1/songs/remote 请求体（provider 中立）
interface RemoteSongItem {
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  duration: number;
  url: string;               // 直链型 provider 有；解析型为空
  plugin_entry_path: string; // provider 自身 entryPath；缺省 '' 表示纯外链
  source_data: string;
  dedup_key: string;
  lyric?: string;
  lyric_source?: string;
}

// songloft /api/v1/songs/remote 响应
interface RemoteSongsResponse {
  count: number;
  songs: Array<{
    id: number;
    type: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    url: string;
    cover_url: string;
    plugin_entry_path: string;
    source_data: string;
    dedup_key: string;
  }>;
}

/**
 * 在线歌曲搜索器
 * 封装对用户配置的外部搜索 API（topone）的调用。
 * MIoT 作为中立消费方，不解读 source_data 内部结构，不写死任何插件名。
 */
export class OnlineSearcher {
  /** 歌手列表搜索最多翻页数（接续补歌靠翻页拿到还没进队列的新歌） */
  private static readonly ARTIST_SEARCH_MAX_PAGES = 3;

  private configManager: ConfigManager;
  private groupCoordinator?: GroupCoordinator;

  constructor(configManager: ConfigManager, groupCoordinator?: GroupCoordinator) {
    this.configManager = configManager;
    this.groupCoordinator = groupCoordinator;
  }

  /**
   * 检查是否配置了外部搜索源（总开关开启且至少有一个启用且有 url 的源）
   */
  async isExternalSearchConfigured(): Promise<boolean> {
    const sources = await this.getEnabledSources();
    return sources.length > 0;
  }

  /**
   * 获取当前生效的外部搜索源列表（总开关关闭返回空；数组顺序即优先级）
   */
  private async getEnabledSources(): Promise<ExternalSearchSource[]> {
    const config = await this.configManager.getConfig();
    if (!config.external_search_enabled) return [];
    return config.external_search_sources.filter((s) => s.enabled && (s.url || '').trim() !== '');
  }

  /**
   * 解析单个源的完整地址
   * 支持两种输入：
   * 1. 完整 URL（以 http:// 或 https:// 开头）直接返回
   * 2. 相对路径（以 / 开头）拼接宿主 loopback 地址（调用其他已安装插件）
   */
  private async resolveSourceUrl(source: ExternalSearchSource): Promise<string> {
    const searchUrl = (source.url || '').trim();
    if (!searchUrl) return '';
    if (searchUrl.startsWith('http://') || searchUrl.startsWith('https://')) {
      return searchUrl;
    }
    // 相对路径 = 内部插件/宿主接口，走 loopback API 地址（避免 hairpin NAT）
    const host = await getHostAPIBaseUrl();
    return host + searchUrl;
  }

  /**
   * 解析单个源的认证 Token
   * 源自定义的 token 优先，否则使用插件 token
   */
  private async resolveSourceToken(source: ExternalSearchSource): Promise<string> {
    const userToken = (source.token || '').trim();
    if (userToken) {
      return userToken;
    }
    const pluginToken = await songloft.plugin.getToken();
    return `Bearer ${pluginToken}`;
  }

  /**
   * 判断直链是否音箱可直接播放。音箱（player_play_url）只可靠播放 mp3；
   * webm/opus/ogg/flac/mka/mkv/m4a/wav 等需经 songloft 转码代理（/proxy/transcode）。
   * 判据：URL 的 mime 查询参数（youtube CDN 带 mime=audio/webm）优先，否则看扩展名。
   */
  private isSpeakerPlayableUrl(rawUrl: string): boolean {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return false;
    }
    const mime = (u.searchParams.get('mime') || '').toLowerCase();
    if (mime === 'audio/mpeg' || mime === 'audio/mp3') return true;
    if (mime.startsWith('audio/')) return false; // webm/opus/ogg/flac/mp4/aac/mka 等
    const ext = (u.pathname.split('.').pop() || '').toLowerCase();
    return ext === 'mp3'; // 无 mime（如 go-music-dl 的 .mp3 直链）→ 仅 .mp3 直推
  }

  /**
   * 解析 no-import 直推 URL：可直接播的原样返回；不可播的构造 songloft 转码代理 URL
   * （/api/v1/proxy/transcode，服务端 ffmpeg 实时转 mp3 流式返回，不入库不落盘）。
   *
   * access_token 必须是首个查询参数——部分音箱固件会把 URL 里的 & 替换为空格，
   * 导致后续参数被合并进 token 值（见 url_builder.ts 同款处理）。URLSearchParams
   * 按 set 顺序输出，故先 set access_token。url 值会被自动 percent-encode，
   * youtube 直链里的 & 不会污染参数分隔。
   */
  private async resolveDirectPushUrl(directUrl: string, duration?: number): Promise<string> {
    if (this.isSpeakerPlayableUrl(directUrl)) return directUrl;
    const base = await getHostBaseUrl(); // 音箱可达地址（server_host），非 loopback 的 getHostAPIBaseUrl
    if (!base) {
      // server_host 未配：无法构造转码 URL，回退原样（大概率播不出，但不构造坏 URL）
      songloft.log.warn('[OnlineSearcher] server_host 未配置，无法走转码代理，原样直推（可能无法解码）');
      return directUrl;
    }
    const token = await songloft.plugin.getToken();
    const params = new URLSearchParams();
    params.set('access_token', token); // 必须第一
    params.set('url', directUrl);
    params.set('format', 'mp3');
    if (duration && duration > 0) params.set('duration', String(duration));
    return `${base}/api/v1/proxy/transcode?${params.toString()}`;
  }

  /**
   * 在线搜索歌曲：并发向所有启用源派发请求，但严格按列表顺序采纳结果
   * （源0 命中即用源0，否则看源1……）。仅返回候选，不导入也不播放。
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @returns 搜索候选，全部未命中或请求失败返回 null
   */
  async search(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
  ): Promise<OnlineSearchResult | null> {
    // 保留正常词间空格；去空白变体仅在源明确未命中后尝试。
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
    keyword = normalize(keyword);
    if (!keyword) return null;
    hint = hint ? { ...hint, title: normalize(hint.title), ...(hint.artist !== undefined ? { artist: normalize(hint.artist) } : {}) } : null;
    const sources = await this.getEnabledSources();
    if (sources.length === 0) return null;

    const config = await this.configManager.getConfig();
    const timeoutSec = config.external_search_timeout > 0 ? config.external_search_timeout : 6;
    const timeoutMs = timeoutSec * 1000;

    // 立即并发派发所有源；searchOne 内部 catch，绝不 reject
    const tasks = sources.map((s) => this.searchOne(s, keyword, hint, timeoutMs, config.external_search_no_import));

    // 按优先级顺序消费：命中即返回（只等到该源），未命中再看下一个
    for (let i = 0; i < tasks.length; i++) {
      const r = await tasks[i];
      if (r) {
        songloft.log.info(`[OnlineSearcher] Hit from source[${i}] "${sources[i].name || sources[i].url}" for keyword: ${keyword}`);
        return r;
      }
    }
    songloft.log.warn('[OnlineSearcher] No source matched for keyword: ' + keyword);
    return null;
  }

  /**
   * 向单个源搜索，明确未命中时最多重试一次去空白变体。
   * 内部处理超时/网络错/解析失败，全部返回 null，绝不 reject。
   */
  private async searchOne(
    source: ExternalSearchSource,
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    timeoutMs: number,
    noImport: boolean,
  ): Promise<OnlineSearchResult | null> {
    const reqBody: SearchOneRequest = {
      keyword,
      hint: hint || undefined,
      quality: '320k',
    };

    const compactBody: SearchOneRequest = {
      ...reqBody,
      keyword: keyword.replace(/\s+/g, ''),
      hint: hint ? {
        ...hint,
        title: hint.title.replace(/\s+/g, ''),
        ...(hint.artist !== undefined ? { artist: hint.artist.replace(/\s+/g, '') } : {}),
      } : undefined,
    };
    const hasVariant = JSON.stringify(compactBody) !== JSON.stringify(reqBody);
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // 两次尝试共用一个期限，包含地址解析、认证、fetch 和响应体读取。
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { finished = true; reject(new Error('AbortError')); }, timeoutMs);
    });
    try {
      const request = (async (): Promise<OnlineSearchResult | null> => {
        const baseUrl = await this.resolveSourceUrl(source);
        if (!baseUrl || finished) return null;
        const authToken = await this.resolveSourceToken(source);
        const attempts = hasVariant ? [reqBody, compactBody] : [reqBody];
        for (let i = 0; i < attempts.length; i++) {
          if (finished) return null;
          const body = attempts[i];
          if (i > 0) songloft.log.info('[OnlineSearcher] Retrying whitespace-free keyword: ' + body.keyword);
          songloft.log.info('[OnlineSearcher] [Diag] Request POST ' + baseUrl + ' body=' + JSON.stringify(body));
          const fetchResp = await fetch(baseUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: authToken,
              ...(!noImport && { 'X-Songloft-Resolve-Url': 'false' }),
            },
            body: JSON.stringify(body),
          });
          if (finished) return null;
          const text = await fetchResp.text();
          if (finished) return null;
          songloft.log.info('[OnlineSearcher] [Diag] Response status=' + fetchResp.status + ' body=' + text);
          let resp: SearchOneResponse | null;
          try {
            resp = JSON.parse(text) as SearchOneResponse;
          } catch {
            songloft.log.warn('[OnlineSearcher] Failed to parse search/topone response: ' + text);
            return null;
          }
          if (resp?.code === 0 && resp.data) return resp.data;
          songloft.log.warn('[OnlineSearcher] Search/topone returned code=' + (resp?.code ?? 'null') + ' for keyword: ' + body.keyword);
          // 仅业务未命中重试；认证、服务端错误和网络失败不加倍请求。
          if (fetchResp.status < 200 || fetchResp.status >= 300 || !(resp?.code === 404 || resp?.code === 0 && !resp.data)) return null;
        }
        return null;
      })();
      return await Promise.race([request, timeoutPromise]);
    } catch (e: any) {
      if (e.message === 'AbortError') {
        songloft.log.warn(`[OnlineSearcher] Search/topone timeout (>${timeoutMs / 1000}s) for source "${source.name || source.url}" keyword: ` + keyword);
      } else {
        songloft.log.warn('[OnlineSearcher] Search/topone fetch error: ' + String(e));
      }
      return null;
    } finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 将外部搜索候选导入到 Songloft，并推送到音箱播放。
   */
  async playSearchResult(
    song: OnlineSearchResult,
    accountId: string,
    deviceId: string,
    minaService: MinaService,
    indexingManager?: IndexingManager,
    pm?: PlaylistManager,
  ): Promise<boolean> {
    const config = await this.configManager.getConfig();

    // 不入库直接播放：仅对「直链型」结果生效（song.url 是 http(s) 直链）。
    // 临时链接（签名 CDN 直链）入库后很快失效、堆成死条目，此模式趁链接新鲜时把原始 URL
    // 直接推给音箱（底层 player_play_url），跳过入库/追加歌单/加索引。
    // 解析型结果（url 为空、靠 plugin_entry_path 让宿主运行时解析）无法脱离曲库播放，回退到入库。
    const directUrl = (song.url || '').trim();
    const isDirectLink = directUrl.startsWith('http://') || directUrl.startsWith('https://');
    if (config.external_search_no_import) {
      if (isDirectLink) {
        // 音箱只可靠播放 mp3；webm/opus 等不可解码格式走 songloft 转码代理（songloft-org/songloft#394）
        const pushUrl = await this.resolveDirectPushUrl(directUrl, song.duration);
        const transcoded = pushUrl !== directUrl;
        const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
        songloft.log.info('[OnlineSearcher] [Diag] No-import direct push: songName="' + songName + '" url="' + pushUrl + '"' + (transcoded ? ' (transcoded)' : ''));
        if (pm && indexingManager) {
          // id=0 只存在于临时队列，不写曲库，也不对它发送已播放/收藏请求。
          return pm.playStandaloneSong({ ...song, id: 0, url: pushUrl, type: 'remote', duration: song.duration || 0 } as any, indexingManager);
        }
        const played = await (this.groupCoordinator || minaService).playURL(accountId, deviceId, pushUrl, {
          title: song.title,
          artist: song.artist,
        });
        if (!played) {
          songloft.log.error('[OnlineSearcher] No-import: failed to push URL to device: ' + pushUrl);
          return false;
        }
        songloft.log.info('[OnlineSearcher] Playing online song (no-import)' + (transcoded ? ' [transcoded]' : '') + ': ' + song.title + ' - ' + song.artist + ' url=' + pushUrl);
        return true;
      }
      songloft.log.info('[OnlineSearcher] No-import enabled but result is resolution-type (no direct url), falling back to import: ' + song.title);
    }

    // 同步导入到 songloft 数据库，直接拿到 songloft 分配的 id 和 url
    const imported = await this.importSong(song);
    if (!imported) {
      songloft.log.error('[OnlineSearcher] Failed to import song, cannot play: ' + song.title);
      return false;
    }

    // 入库后追加到目标歌单（可选，由配置决定）
    const pid = config.external_search_playlist_id;
    let appendedPlaylistId: number | undefined;
    if (pid) {
      try {
        const plToken = await songloft.plugin.getToken();
        const apiBase = await getHostAPIBaseUrl();
        await fetch(`${apiBase}/api/v1/playlists/${pid}/songs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plToken}` },
          body: JSON.stringify({ song_ids: [imported.id] }),
        });
        const pidNum = Number(pid);
        if (!Number.isNaN(pidNum)) appendedPlaylistId = pidNum;
      } catch (e) { songloft.log.warn(`[OnlineSearcher] 追加歌单失败: ${String(e)}`); }
    }

    // 已追加到目标歌单且提供了播放管理器：接管为完整歌单播放，从这首新歌
    // 开始，播完后由 PlaylistManager 的切歌定时器自动续播歌单其余歌曲。
    // （直接 playURL 单曲推送不会注册切歌定时器，播完即停，见 issue #53）
    if (pm && appendedPlaylistId !== undefined) {
      const ok = await pm.playPlaylistFromSong(appendedPlaylistId, imported.id);
      if (ok) {
        // 增量把这首独立远程歌曲加入内存索引，避免为一首歌重建全部歌单缓存。
        if (indexingManager) {
          indexingManager.addImportedSong(
            { id: imported.id, title: song.title, artist: song.artist, album: song.album },
            appendedPlaylistId,
          );
        }
        songloft.log.info(`[OnlineSearcher] Playing online song via playlist ${appendedPlaylistId} (auto-continue): ${song.title} - ${song.artist}`);
        return true;
      }
      songloft.log.warn(`[OnlineSearcher] Playlist takeover failed for playlist ${appendedPlaylistId}, falling back to single URL push`);
    }

    // 没有目标歌单时，导入歌曲与已入库的独立歌曲共用临时歌手队列。
    if (pm && indexingManager) {
      indexingManager.addImportedSong({ id: imported.id, title: song.title, artist: song.artist, album: song.album });
      let fullSong: any = { ...song, id: imported.id, url: imported.url, type: 'remote' };
      try {
        fullSong = await songloft.songs.getById(imported.id) || fullSong;
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] Failed to read imported song detail: ' + String(e));
      }
      return pm.playStandaloneSong(fullSong, indexingManager, undefined,
        (artist, have, want, isCurrent) => this.topupQueueSongs(artist, have, want, indexingManager, isCurrent));
    }

    // 用返回的 url 构造完整播放 URL（相对路径，URLBuilder 会拼接 server_host 和 token）。
    // 必须带上 force_mp3 / volume_normalize：直推路径漏了这些选项时，音箱会拿到不能解码的
    // 源格式流而亮灯不出声（songloft-org/songloft-plugin-miot#62）。
    const playUrl = await URLBuilder.buildSongURL({ id: imported.id, url: imported.url }, playbackOptionsOf(config));
    if (!playUrl) {
      songloft.log.error('[OnlineSearcher] Failed to build URL for song id=' + imported.id);
      return false;
    }

    // 推送 URL 到音箱（传「歌名-歌手」供触屏歌词模式匹配曲库）
    const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
    songloft.log.info('[OnlineSearcher] [Diag] Push to device: songName="' + songName + '" importedUrl="' + imported.url + '" playUrl="' + playUrl + '"');
    const played = await (this.groupCoordinator || minaService).playURL(accountId, deviceId, playUrl, {
      title: song.title,
      artist: song.artist,
    });
    if (!played) {
      songloft.log.error('[OnlineSearcher] Failed to push URL to device: ' + playUrl);
      return false;
    }

    // 增量把这首独立远程歌曲加入内存索引，避免为一首歌重建全部歌单缓存。
    if (indexingManager) {
      indexingManager.addImportedSong(
        { id: imported.id, title: song.title, artist: song.artist, album: song.album },
        appendedPlaylistId,
      );
    }

    songloft.log.info('[OnlineSearcher] Playing online song: ' + song.title + ' - ' + song.artist + ' url=' + playUrl);
    return true;
  }

  /**
   * 在线搜索歌曲并推送到音箱播放，同时导入到本地数据库
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @param accountId    平台账号ID
   * @param deviceId     设备ID
   * @param minaService  MinaService 实例（用于推送URL）
   * @returns 是否成功推送播放
   */
  async searchAndPlay(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    accountId: string,
    deviceId: string,
    minaService: MinaService,
  ): Promise<boolean> {
    const song = await this.search(keyword, hint);
    if (!song) {
      return false;
    }
    return await this.playSearchResult(song, accountId, deviceId, minaService);
  }

  // ===== 独立歌曲队列在线补歌（StandaloneTopup） =====
  // 点播独立歌曲时 PlaylistManager 只会续播本地曲库的同歌手歌曲；只用在线音源的
  // 用户曲库里往往只有刚命中的一首，队列 total=1、播完即停。这里复用外部搜索源的
  // 列表搜索（与 topone 同一 provider 的 /api/search 列表端点）按歌手拉一批歌曲，
  // 入库后以 remote 歌曲补进队列。全部失败静默返回空，绝不阻断原播放。

  /**
   * 按歌手列表搜索。excludeKeys 是调用方已有歌曲的归一化键（title|artist），
   * 命中排除集的结果不计入 want——接续补歌靠它翻页深挖「还没进队列」的新歌，
   * 而不是每轮都把第一页的老结果再端回来。
   */
  private async searchArtistSongs(
    artist: string,
    want: number,
    excludeKeys?: Set<string>,
  ): Promise<OnlineSearchResult[]> {
    const target = (artist || '').trim();
    if (!target || want <= 0) return [];
    const sources = await this.getEnabledSources();
    if (sources.length === 0) return [];
    const config = await this.configManager.getConfig();
    const timeoutMs = Math.min((config.external_search_timeout > 0 ? config.external_search_timeout : 6) * 1000, 8000);
    for (const source of sources) {
      try {
        const results = await this.searchArtistOnSource(source, target, want, timeoutMs, excludeKeys);
        if (results.length > 0) return results;
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] Artist list search failed for source "' + (source.name || source.url) + '": ' + String(e));
      }
    }
    return [];
  }

  /**
   * 向单个源的列表端点按歌手搜索。列表端点由 topone 地址推导
   * （.../api/search/topone → .../api/search），且必须是宿主 jsplugin 相对/绝对
   * 地址（entryPath 从地址解析，不写死任何插件名）；形状不符直接放弃该源。
   * 平台逐个尝试、逐页翻（最多 ARTIST_SEARCH_MAX_PAGES 页），某平台某页返回
   * 0 条即视为该平台耗尽；凑够 want 首「未被排除」的结果即停。
   * 结果按署名匹配过滤。每发一次请求都打一条响应摘要日志（code / data 键名 /
   * 条数 / 首项键名），响应形状与预期不符时能直接从宿主日志定位。
   */
  private async searchArtistOnSource(
    source: ExternalSearchSource,
    artist: string,
    want: number,
    timeoutMs: number,
    excludeKeys?: Set<string>,
  ): Promise<OnlineSearchResult[]> {
    const baseUrl = await this.resolveSourceUrl(source);
    if (!baseUrl) return [];
    const listUrl = baseUrl.replace(/\/search\/topone\/?$/, '/search');
    if (listUrl === baseUrl) return [];
    const entryMatch = /\/jsplugin\/([^/]+)\//.exec(baseUrl);
    if (!entryMatch) return [];
    const entryPath = entryMatch[1];
    const authToken = await this.resolveSourceToken(source);
    const sourceLabel = source.name || entryPath;

    const collected: OnlineSearchResult[] = [];
    const seenKeys = new Set<string>();
    const exhaustedPlatforms = new Set<string>();
    for (let page = 1; page <= OnlineSearcher.ARTIST_SEARCH_MAX_PAGES; page++) {
      if (collected.length >= want) break;
      for (const platform of ['tx', 'kg', 'kw', 'wy', 'mg']) {
        if (collected.length >= want) break;
        if (exhaustedPlatforms.has(platform)) continue;
        const resp = await this.fetchJsonWithTimeout(listUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authToken },
          body: JSON.stringify({ keyword: artist, source_id: platform, type: 'song', page, quality: '320k' }),
        }, timeoutMs);
        // 响应形状兼容：data 可能是 {results:[...]} / {list:[...]} / {songs:[...]}
        // 或直接数组。字段名未经 provider 文档确认，以实测日志为准逐步收敛。
        const data = resp?.code === 0 ? resp.data : undefined;
        const items: any[] = Array.isArray(data) ? data
          : (data?.results || data?.list || data?.songs || []);
        const dataKeys = data === undefined ? 'none'
          : Array.isArray(data) ? '(array)'
          : (data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data);
        const itemKeys = items.length > 0 && items[0] && typeof items[0] === 'object'
          ? Object.keys(items[0]).join(',') : '';
        songloft.log.info(`[StandaloneTopup] list search source="${sourceLabel}" platform=${platform} page=${page} code=${resp ? resp.code : 'no-response'} dataKeys=${dataKeys} items=${items.length}${itemKeys ? ' itemKeys=' + itemKeys : ''}`);
        if (items.length === 0) {
          exhaustedPlatforms.add(platform);
          continue;
        }
        for (const item of items) {
          if (collected.length >= want) break;
          if (!item?.title || !item.source_data) continue;
          if (!this.artistMatches(item.artist || '', artist)) continue;
          const converted = this.listItemToResult(item, entryPath);
          if (!converted) continue;
          const normKey = `${(converted.title || '').trim().toLowerCase()}|${(converted.artist || '').trim().toLowerCase()}`;
          if (excludeKeys && excludeKeys.has(normKey)) continue;
          const key = converted.dedup_key || normKey;
          if (seenKeys.has(key) || seenKeys.has(normKey)) continue;
          seenKeys.add(key);
          seenKeys.add(normKey);
          collected.push(converted);
        }
      }
    }
    return collected;
  }

  /** 列表项 → 搜索候选：补 topone 响应才带的 plugin_entry_path 与 dedup_key */
  private listItemToResult(item: any, entryPath: string): OnlineSearchResult | null {
    const sourceData = item.source_data;
    if (!sourceData || typeof sourceData !== 'object') return null;
    const info = sourceData.songInfo || {};
    const platform = String(sourceData.platform || info.source || '');
    // 与 provider 侧 dedup 规则对齐：kg 优先 albumAudioId，其次 songmid/musicId/hash/copyrightId
    const idPart = (platform === 'kg' && info.albumAudioId) || info.songmid || info.musicId || info.hash || info.copyrightId || '';
    return {
      title: item.title,
      artist: item.artist || '',
      album: item.album || '',
      duration: item.duration || 0,
      cover_url: item.cover_url || '',
      plugin_entry_path: entryPath,
      source_data: sourceData,
      dedup_key: platform && idPart ? `${platform}:${idPart}` : '',
    };
  }

  /** 署名匹配：全等、分隔符拆分后的任一段全等，或双向包含（短方至少 2 字） */
  private artistMatches(candidate: string, target: string): boolean {
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, '');
    const c = norm(candidate);
    const t = norm(target);
    if (!c || !t) return false;
    if (c === t) return true;
    const parts = (candidate || '').split(/[,，、/&;；·]/).map(norm).filter(Boolean);
    if (parts.includes(t)) return true;
    return Math.min(c.length, t.length) >= 2 && (c.includes(t) || t.includes(c));
  }

  /** 带总期限的 JSON 请求：超时/解析失败一律返回 null（与 searchOne 同款竞速守卫） */
  private async fetchJsonWithTimeout(url: string, init: any, timeoutMs: number): Promise<any | null> {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { finished = true; reject(new Error('AbortError')); }, timeoutMs);
    });
    try {
      const request = (async (): Promise<any | null> => {
        const resp = await fetch(url, init);
        if (finished) return null;
        const text = await resp.text();
        if (finished) return null;
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();
      return await Promise.race([request, timeoutPromise]);
    } catch {
      return null;
    } finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 批量导入搜索候选到 songloft 数据库（/api/v1/songs/remote 数组形式）。
   * 批量响应按 dedup_key / 标题+歌手 / 顺序对齐；未对齐的逐首回退 importSong。
   * @returns 成功入库的歌曲（含真实 id/url 与候选元信息），失败项静默跳过
   */
  async importSongs(
    songs: OnlineSearchResult[],
  ): Promise<Array<{ id: number; url: string; title: string; artist: string; album: string; duration: number; cover_url: string }>> {
    const out: Array<{ id: number; url: string; title: string; artist: string; album: string; duration: number; cover_url: string }> = [];
    if (!songs.length) return out;
    const matched = new Array<boolean>(songs.length).fill(false);
    try {
      const pluginToken = await songloft.plugin.getToken();
      const serverHost = await getHostAPIBaseUrl();
      const fetchResp = await fetch(serverHost + '/api/v1/songs/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pluginToken}` },
        body: JSON.stringify(songs.map((s) => this.toRemoteItem(s))),
      });
      const text = await fetchResp.text();
      let result: RemoteSongsResponse | null = null;
      try {
        result = JSON.parse(text) as RemoteSongsResponse;
      } catch {
        songloft.log.warn('[OnlineSearcher] Failed to parse batch remote songs response: ' + text);
      }
      const returned = result?.songs || [];
      for (let i = 0; i < songs.length; i++) {
        const src = songs[i];
        const hit = returned.find((r) => !!src.dedup_key && r.dedup_key === src.dedup_key)
          || returned.find((r) => r.title === src.title && r.artist === (src.artist || ''))
          || (returned.length === songs.length ? returned[i] : undefined);
        if (hit && hit.id) {
          matched[i] = true;
          out.push({ id: hit.id, url: hit.url || '', title: src.title, artist: src.artist || '', album: src.album || '', duration: src.duration || 0, cover_url: src.cover_url || '' });
        }
      }
    } catch (e) {
      songloft.log.warn('[OnlineSearcher] Batch import fetch error: ' + String(e));
    }
    // 批量未覆盖到的逐首回退（单首 importSong 内部自带已存在查找）
    for (let i = 0; i < songs.length; i++) {
      if (matched[i]) continue;
      try {
        const one = await this.importSong(songs[i]);
        if (one && one.id) {
          out.push({ id: one.id, url: one.url || '', title: songs[i].title, artist: songs[i].artist || '', album: songs[i].album || '', duration: songs[i].duration || 0, cover_url: songs[i].cover_url || '' });
        }
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] Topup import fallback failed for "' + songs[i].title + '": ' + String(e));
      }
    }
    return out;
  }

  /**
   * 独立歌曲队列补歌：按歌手在线搜索 → 入库 → 返回可入队的完整歌曲对象。
   * 供 PlaylistManager.playStandaloneSong 的首轮补歌与接续补歌共用；
   * 任何失败返回已得部分或空数组。无论结果如何都打一条 round 汇总日志
   * （含 0 首与原因），杜绝静默无日志。
   */
  async topupQueueSongs(
    artist: string,
    have: Array<{ id: number; title: string; artist?: string }>,
    want: number,
    indexingManager?: IndexingManager,
    isCurrent: () => boolean = () => true,
  ): Promise<any[]> {
    const key = (title: string, a: string) => `${(title || '').trim().toLowerCase()}|${(a || '').trim().toLowerCase()}`;
    const haveKeys = new Set(have.map((s) => key(s.title, s.artist || '')));
    let searched = 0;
    let freshCount = 0;
    let importedCount = 0;
    const done = (out: any[], reason: string): any[] => {
      songloft.log.info(`[StandaloneTopup] round artist="${artist}" want=${want} searched=${searched} fresh=${freshCount} imported=${importedCount} returned=${out.length} reason=${reason}`);
      return out;
    };
    if (want <= 0 || !isCurrent()) return done([], 'not-current-or-no-want');
    // 排除集传进搜索层：翻页时跳过队列里已有的歌，深挖后面的新歌。
    const results = await this.searchArtistSongs(artist, want + 5, haveKeys);
    searched = results.length;
    if (!results.length || !isCurrent()) return done([], results.length ? 'not-current' : 'search-empty');
    const fresh = results.filter((r) => !haveKeys.has(key(r.title, r.artist || '')));
    freshCount = fresh.length;
    if (!fresh.length) return done([], 'all-duplicates');
    const imported = await this.importSongs(fresh.slice(0, want + 5));
    importedCount = imported.length;
    if (!imported.length) return done([], 'import-failed');
    const out: any[] = [];
    const seenIds = new Set(have.map((s) => s.id));
    const seenKeys = new Set(haveKeys);
    for (const imp of imported) {
      if (out.length >= want || !isCurrent()) break;
      const k = key(imp.title, imp.artist);
      if (seenIds.has(imp.id) || seenKeys.has(k)) continue;
      seenIds.add(imp.id);
      seenKeys.add(k);
      let full: any = null;
      try {
        full = await songloft.songs.getById(imp.id);
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] Topup getById failed id=' + imp.id + ': ' + String(e));
      }
      out.push(full && full.url ? full : {
        id: imp.id, url: imp.url, type: 'remote',
        title: imp.title, artist: imp.artist, album: imp.album,
        duration: imp.duration, cover_url: imp.cover_url,
      });
      if (indexingManager) {
        try {
          indexingManager.addImportedSong({ id: imp.id, title: imp.title, artist: imp.artist, album: imp.album });
        } catch { /* 索引增量失败不影响入队 */ }
      }
    }
    return done(out, out.length ? 'ok' : 'all-duplicates');
  }

  /** 搜索候选 → 宿主 /api/v1/songs/remote 请求项（provider 字段原样映射，不解读、不补插件名） */
  private toRemoteItem(song: OnlineSearchResult): RemoteSongItem {
    return {
      title: song.title,
      artist: song.artist || '',
      album: song.album || '',
      cover_url: song.cover_url || '',
      duration: song.duration || 0,
      url: song.url || '',                              // 直链型 provider 有；解析型为空
      plugin_entry_path: song.plugin_entry_path || '',  // 中立缺省 ''，绝不写死任何插件名
      source_data: typeof song.source_data === 'string'
        ? song.source_data
        : (song.source_data ? JSON.stringify(song.source_data) : ''),   // 对象则序列化，不窥内部
      dedup_key: song.dedup_key || '',
      lyric: song.lyric || '',
      lyric_source: song.lyric_source || '',
    };
  }

  /**
   * 导入歌曲到 songloft 数据库
   * @returns 导入成功后包含歌曲 id 和 url 的对象，失败返回 null
   */
  private async importSong(song: OnlineSearchResult): Promise<{ id: number; url: string } | null> {
    const remoteItem = this.toRemoteItem(song);

    try {
      const pluginToken = await songloft.plugin.getToken();
      const serverHost = await getHostAPIBaseUrl();
      const fetchResp = await fetch(serverHost + '/api/v1/songs/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pluginToken}` },
        body: JSON.stringify([remoteItem]),
      });
      const text = await fetchResp.text();
      let result: RemoteSongsResponse;
      try {
        result = JSON.parse(text) as RemoteSongsResponse;
      } catch {
        songloft.log.warn('[OnlineSearcher] Failed to parse remote songs response: ' + text);
        // 导入失败（可能是 UNIQUE 约束冲突），尝试查找已存在的歌曲
        return await this.findExistingSong(song.title, song.artist);
      }

      if (!result.songs || result.songs.length === 0) {
        songloft.log.warn('[OnlineSearcher] Remote import returned no songs: ' + text);
        // 导入失败，尝试查找已存在的歌曲
        return await this.findExistingSong(song.title, song.artist);
      }

      const imported = result.songs[0];
      songloft.log.info('[OnlineSearcher] Import success: ' + song.title + ' - ' + song.artist + ', songloft id=' + imported.id);
      return { id: imported.id, url: imported.url };
    } catch (e: any) {
      songloft.log.warn('[OnlineSearcher] Remote import fetch error: ' + String(e));
      return null;
    }
  }

  /**
   * 在 Songloft 数据库中查找已存在的外部导入歌曲
   * 当 /api/v1/songs/remote 因唯一键约束冲突等无法重复导入时作为回退
   */
  private async findExistingSong(title: string, artist: string): Promise<{ id: number; url: string } | null> {
    try {
      let songLimit = 10000;
      try {
        const cfg = await this.configManager.getConfig();
        songLimit = Math.max(1000, Math.min(100000, cfg.max_song_index ?? 10000));
      } catch {}
      const allSongs = await songloft.songs.list({ limit: songLimit });
      const match = allSongs.find(s =>
        s.title === title &&
        s.artist === artist &&
        (s.type === 'remote' || s.url?.startsWith('http'))
      );
      if (match && match.id && match.url) {
        songloft.log.info('[OnlineSearcher] Found existing remote song: ' + title + ' - ' + artist + ', id=' + match.id);
        return { id: match.id, url: match.url };
      }
    } catch (e) {
      songloft.log.warn('[OnlineSearcher] Failed to search existing songs: ' + String(e));
    }
    return null;
  }
}
