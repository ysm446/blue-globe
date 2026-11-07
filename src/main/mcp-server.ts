// MCP サーバー。Claude Code などの MCP クライアントから、地球儀のカメラ、ハイライト、字幕、ツアーを動かす。
// http://127.0.0.1:<ポート>/mcp で待ち受け (Streamable HTTP、状態を持たない)、ほかの PC からはつながらない。
// ツールの処理は画面 (レンダラー) で行い、IPC で結果を受け取る (mcp-bridge.ts)。設定の「MCP サーバー」がオンの間だけ動く
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const MCP_PORT = 47815;
const CALL_TIMEOUT_MS = 30_000;
const SCREENSHOT_WIDTH = 1280; // 画像を LLM に渡すときの幅。物理ピクセルのままでは大きすぎる

type Json = Record<string, unknown>;

// 画面へツールの処理を頼み、結果を待つ
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
ipcMain.on('mcp:reply', (_event, id: string, ok: boolean, value: unknown) => {
  const call = pending.get(id);
  if (!call) return;
  pending.delete(id);
  if (ok) call.resolve(value);
  else call.reject(new Error(String(value)));
});

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
}

function callRenderer(tool: string, args: Json): Promise<unknown> {
  const win = mainWindow();
  if (!win) return Promise.reject(new Error('アプリの窓が開いていません'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('画面から応答がありません'));
    }, CALL_TIMEOUT_MS);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    win.webContents.send('mcp:call', id, tool, args);
  });
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const failure = (error: unknown) => ({ content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true });
const relay = (tool: string) => async (args: Json) => {
  try {
    return text(await callRenderer(tool, args));
  } catch (error) {
    return failure(error);
  }
};

// 見た目の指定 (どのハイライトにも付けられる)
const style = {
  label: z.string().optional().describe('画面に出す名前。省くと、範囲と点は日本語名、川は英語名'),
  color: z
    .string()
    .optional()
    .describe('色。パレットの名前 (sky, teal, gold, coral, violet, leaf, snow) か CSS の色。省くと種類に合った色'),
  dashed: z.boolean().optional().describe('破線にする (推定のルートや別の説など)'),
  arrows: z.boolean().optional().describe('進む向きの矢印 (座標の線は既定で付く。川は流れる光で向きを示すので付かない)'),
  countries: z.boolean().optional().describe('通る国・重なる国の名前と国旗を出すか (既定は出す。歴史の話では false)'),
};
const latLon = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const highlightSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('river'), name: z.string().describe('川の英語名 (Danube, Nile, Amazonas など)'), ...style }),
  z.object({ type: z.literal('area'), name: z.string().describe('山脈・砂漠などの英語名か日本語名 (Alps, アルプス山脈, Sahara など)'), ...style }),
  z.object({
    type: z.literal('point'),
    name: z.string().optional().describe('山頂・滝などの名前 (Mount Everest, 富士山 など)。データにないときは lat と lon で置く'),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    elevation: z.number().optional().describe('標高 (m)。座標で置くときに出したい場合'),
    ...style,
  }),
  z.object({ type: z.literal('line'), points: z.array(latLon).min(2).describe('[緯度, 経度] の並び'), name: z.string().optional(), ...style }),
  z.object({
    type: z.literal('arrow'),
    points: z.array(latLon).min(2).describe('[緯度, 経度] の並び。根元から先端へ。点を直線で結び、角を丸める。曲がる所には点を置く。135° より大きく曲がる所 (来た道を戻る所) では矢印を分ける'),
    width: z.number().min(1).max(2000).optional().describe('太さ (km)。省くと長さの 3.5% (10〜150km)。同じ所から出る矢印や、範囲を示す場面では 30km 前後に細くする'),
    fade: z
      .boolean()
      .optional()
      .describe('根元をグラデーションで消す。前の場面から続いている道の一部や、出発点のはっきりしない流れ (伝播、移動) に使う。はっきりした出発点から始まるときは付けない'),
    offset: z
      .number()
      .min(-500)
      .max(500)
      .optional()
      .describe('根元と先端を横へずらす幅 (km)。正は進む向きの右、負は左。途中は渡した点を通る。同じ所から出る・同じ所へ向かう矢印の重なりを避けるときに、帯の太さほどずらす'),
    opaque: z
      .boolean()
      .optional()
      .describe('塗りをほぼ不透明にする。主役の動きをはっきり見せたいときに使う。矢印の下の地形や範囲を見せたい場面では付けない'),
    name: z.string().optional(),
    ...style,
  }),
  z.object({ type: z.literal('polygon'), points: z.array(latLon).min(3).describe('[緯度, 経度] の並び (輪郭)'), name: z.string().optional(), ...style }),
]);
const camera = {
  heading: z.number().optional().describe('方角 (度。0 が北)'),
  tilt: z.number().min(0).max(72).optional().describe('傾き (度。0 が真下、大きいほど水平に近い)'),
  orbit: z.number().min(-5).max(5).optional().describe('着いてから中心のまわりを回る速さ (-5〜5。正が右回り)。省くと回らない'),
};

function createServer(): McpServer {
  const server = new McpServer({ name: 'weather-globe', version: '0.1.0' });
  server.registerTool(
    'get_view',
    { description: '今の視点 (地球、地域、太陽系)、表示モード、カメラの中心と高さ、表示中の時刻、中心での太陽の高さ、ツアーの進み具合を返す。', inputSchema: {} },
    relay('get_view'),
  );
  server.registerTool(
    'fly_to',
    {
      description: '地点へカメラを飛ばす (地域ビュー)。altitude_km はカメラの高さのおおよそ (230〜6,000km。既定 1,000km)。',
      inputSchema: { lat: z.number().min(-80).max(80), lon: z.number().min(-180).max(180), altitude_km: z.number().optional(), ...camera },
    },
    relay('fly_to'),
  );
  server.registerTool(
    'highlight',
    {
      description:
        '地図に重ねて示す。川をなぞる (river)、山脈・砂漠などの範囲 (area)、山頂などの点 (point)、座標の線 (line)、太さのある矢印 (arrow。進軍や移動の大きな流れ) と多角形 (polygon)。結果に名前、範囲、通る国などを返す。append が false (既定) なら前のハイライトは消える。示したあとは frame_highlights でカメラを寄せる。',
      inputSchema: { spec: highlightSpec, append: z.boolean().optional() },
    },
    relay('highlight'),
  );
  server.registerTool(
    'frame_highlights',
    { description: '示しているハイライトが全部画面に収まるよう、カメラを寄せる・引く。', inputSchema: camera },
    relay('frame_highlights'),
  );
  server.registerTool('clear_highlights', { description: 'ハイライトを全部消す。', inputSchema: {} }, relay('clear_highlights'));
  server.registerTool(
    'show_caption',
    {
      description: '画面の下に説明の字幕を出す (文字が順に現れる)。seconds を渡すと、出し終えてからその秒数で消える。',
      inputSchema: { text: z.string(), seconds: z.number().optional() },
    },
    relay('show_caption'),
  );
  server.registerTool('clear_caption', { description: '字幕を消す。', inputSchema: {} }, relay('clear_caption'));
  server.registerTool(
    'play_tour',
    {
      description:
        'ツアーを始める。場面ごとにハイライト、字幕、カメラ、時刻を指定する。見る人が字幕をクリックすると次の場面へ進み、最後で最初に戻る (Esc で終わる)。再生中のツアーは画面のツアーのパネルで保存でき、保存したツアーはいつでもパネルから再生できる。',
      inputSchema: {
        title: z.string().max(80).optional().describe('ツアーの名前 (「世界の長い川」など)。パネルの一覧に出る'),
        save: z.boolean().optional().describe('true で始めると同時に保存する (見る人が保存を頼んだとき)。省くと保存しない'),
        scenes: z
          .array(
            z.object({
              highlights: z.array(highlightSpec),
              caption: z.string().optional(),
              camera: z.object(camera).optional(),
              time: z
                .object({
                  hour: z.number().min(0).max(24).optional().describe('その場所の地方時 (0〜24)'),
                  iso: z.string().optional().describe('日時 (ISO 8601)'),
                })
                .optional(),
            }),
          )
          .min(1),
      },
    },
    relay('play_tour'),
  );
  server.registerTool('stop_tour', { description: 'ツアーを終える。', inputSchema: {} }, relay('stop_tour'));
  server.registerTool(
    'set_time',
    {
      description: '表示する時刻 (太陽の位置) を変える。hour は今見ている場所の地方時、iso は日時。どちらも省くと今に戻す。',
      inputSchema: { hour: z.number().min(0).max(24).optional(), iso: z.string().optional() },
    },
    relay('set_time'),
  );
  server.registerTool(
    'set_mode',
    { description: '表示モードを変える。normal (雲なし)、weather (雲あり)、wind (風速。地球ビューだけ)。', inputSchema: { mode: z.enum(['normal', 'weather', 'wind']) } },
    relay('set_mode'),
  );
  server.registerTool(
    'set_view',
    { description: '視点を変える。globe (地球)、region (地域)、solar (太陽系)。', inputSchema: { view: z.enum(['globe', 'region', 'solar']) } },
    relay('set_view'),
  );
  server.registerTool(
    'set_map_lines',
    { description: '海岸線と国境線を出すか (この場だけ。設定は変えない)。', inputSchema: { visible: z.boolean() } },
    relay('set_map_lines'),
  );
  server.registerTool(
    'screenshot',
    { description: '今の画面を画像で返す。狙いどおりに映ったか確かめるのに使う。', inputSchema: {} },
    async () => {
      const win = mainWindow();
      if (!win) return failure('アプリの窓が開いていません');
      try {
        let image = await win.webContents.capturePage();
        const { width } = image.getSize();
        if (width > SCREENSHOT_WIDTH) image = image.resize({ width: SCREENSHOT_WIDTH, quality: 'good' });
        return { content: [{ type: 'image' as const, data: image.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' }] };
      } catch (error) {
        return failure(error);
      }
    },
  );
  return server;
}

let httpServer: http.Server | null = null;

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.url?.split('?')[0] !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  // 状態を持たないので、POST だけを受ける (GET の通知の流れと DELETE は使わない)
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400).end('invalid JSON');
    return;
  }
  // 要求ごとにサーバーと受け渡しを作る (SDK の状態を持たない使い方)
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function setMcpServerEnabled(enabled: boolean): void {
  if (enabled === (httpServer !== null)) return;
  if (!enabled) {
    httpServer?.close();
    httpServer = null;
    console.log('MCP server stopped');
    return;
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('MCP request failed', error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.on('error', (error) => {
    console.error('MCP server error', error);
    if (httpServer === server) httpServer = null;
  });
  server.listen(MCP_PORT, '127.0.0.1', () => console.log(`MCP server listening on http://127.0.0.1:${MCP_PORT}/mcp`));
  httpServer = server;
}
