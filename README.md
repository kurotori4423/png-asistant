# PNG アシスタント表示システム

音声に反応して口パク・瞬きするWeb表示アシスタント。
外部システム（TTSなど）からHTTP POSTで音声データを受信し、ブラウザ上でリアルタイム再生しながらキャラクターアニメーションを行う。

**Stage 1** では画面左下にテキストチャット UI を追加した。
ブラウザで文字を入力すると、サーバー経由で OpenClaw Gateway へ転送され、アシスタントの返答がストリーミングで表示される。
OpenClaw トークンはブラウザに渡らず、サーバー側の環境変数のみで管理される。

---

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 画像の配置

`images/` フォルダに以下の6枚のPNG画像を配置する。

| ファイル名 | 内容 |
|-----------|------|
| `background.png` | 背景 |
| `normal.png` | 通常状態の立ち絵（標準目） |
| `closed.png` | 目つむり立ち絵（瞬き用） |
| `half.png` | 半目立ち絵（瞬き遷移用） |
| `smile.png` | 笑い目差分（透過PNG） |
| `mouth.png` | 閉じ口差分（透過PNG） |

すべて同じ解像度で揃えること。`smile.png` と `mouth.png` は透過PNGとして下のレイヤーに重ねる。

### 3. 環境変数の設定（Stage 1）

| 変数名 | 説明 | デフォルト値 |
|--------|------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway の認証トークン（**必須**、ブラウザには渡らない） | （空文字） |
| `OPENCLAW_GATEWAY_WS_URL` | Gateway WebSocket エンドポイント | `ws://127.0.0.1:18789/ws` |
| `OPENCLAW_SESSION_KEY` | チャットセッションキー | `agent:main:main` |
| `PORT` | HTTP サーバーのポート番号 | `3000` |

### 4. サーバー起動

```bash
# 最小構成（トークンなし / Gateway がローカルに動いている場合）
node server.js

# トークン付き（推奨）
OPENCLAW_GATEWAY_TOKEN=<your_token> node server.js

# フル指定例
OPENCLAW_GATEWAY_TOKEN=<your_token> \
OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789/ws \
OPENCLAW_SESSION_KEY=agent:main:main \
PORT=3000 \
node server.js
```

### 5. ブラウザで開く

```
http://localhost:3000
```

---

## テキストチャット（Stage 1）

画面左下のチャットパネルにメッセージを入力して **Send** を押す（または Enter キー）。

- ユーザーの発言が右側のバブルに、アシスタントの返答が左側のバブルにストリーミングで表示される。
- パネル右上の **−** ボタンで折り畳める。
- **セキュリティ**: OpenClaw トークンはサーバー側の環境変数 `OPENCLAW_GATEWAY_TOKEN` でのみ管理され、ブラウザには一切渡らない。

### チャット API（直接呼び出し）

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello!"}'
# → {"ok":true,"idempotencyKey":"<uuid>"}
# アシスタントの返答は WebSocket で配信される
```

---

## 音声の送り方

### HTTP POST（主な使い方）

`multipart/form-data` でフィールド名 `audio` に音声ファイルを添付して送信する。
WAV・MP3・OGG に対応。

```bash
# WAV
curl -X POST http://localhost:3000/api/speak -F "audio=@voice.wav"

# MP3
curl -X POST http://localhost:3000/api/speak -F "audio=@voice.mp3"
```

受信するとすぐにブラウザへWebSocket経由で転送され、再生と口パクが始まる。

### ファイルを上書きするだけで自動再生

プロジェクトルート（`server.js` と同じ階層）に `.mp3` / `.wav` / `.ogg` ファイルを置くか上書きすると、サーバーが変更を検知して自動的にブラウザへ送信・再生する。
TTSの出力先をルートに向けておくだけで連携できる。

### 直近の音声を再生し直す

```bash
curl http://localhost:3000/api/replay
```

サーバーが最後に受信した音声を再ブロードキャストする。
サーバー起動時はルートにある最終更新日時が新しいファイルが自動でセットされるため、起動直後でも使える。

---

## 表情の変更

```bash
# 笑顔
curl -X POST http://localhost:3000/api/expression \
  -H "Content-Type: application/json" \
  -d '{"expression":"smile"}'

# 通常に戻す
curl -X POST http://localhost:3000/api/expression \
  -H "Content-Type: application/json" \
  -d '{"expression":"normal"}'
```

ブラウザのコントロールパネルのボタンからも切り替えられる。

---

## ブラウザのコントロールパネル

画面右下に操作パネルが表示される。

| ボタン／コントロール | 機能 |
|---------------------|------|
| ▶ テスト再生 | 直近の音声を再生（口パク確認用） |
| ✦ エフェクト | bloomグロー＋サイバートライアングルパーティクルのON/OFF |
| 通常 / 笑顔 | 表情切り替え |
| 🔊 スライダー | 再生音量の調整（0〜100%） |

---

## 画面操作

| 操作 | 動作 |
|------|------|
| スクロール | カーソル位置を中心にズームイン／アウト（0.1x〜8x） |
| 左クリック＋ドラッグ | 画面のパン（移動） |
| 2本指ピンチ（タッチ） | ズームイン／アウト |
| 1本指スワイプ（タッチ） | パン |

---

## API リファレンス

| メソッド | パス | 説明 |
|---------|------|------|
| `POST` | `/api/speak` | 音声ファイルを受信してブラウザへ転送・再生 |
| `GET` | `/api/replay` | 直近の音声を再ブロードキャスト |
| `POST` | `/api/expression` | 表情変更 (`normal` / `smile`) |
| `POST` | `/api/chat` | テキストを Gateway へ転送、返答は WS でストリーミング配信（Stage 1） |
| `WS` | `ws://localhost:3000` | ブラウザとの双方向通信 |

### WebSocket メッセージ形式（サーバー → ブラウザ）

```json
{ "type": "audio",      "data": "<base64>", "mimeType": "audio/wav" }
{ "type": "expression", "value": "normal" }
{ "type": "expression", "value": "smile"  }
{ "type": "chat.delta", "runId": "<id>", "text": "<chunk>" }
{ "type": "chat.final", "runId": "<id>", "text": "<full>", "state": "done" }
{ "type": "chat.error", "runId": "<id>", "error": "<message>" }
```

### OpenClaw Gateway 実プロトコル（サーバー↔Gateway、ブラウザは関与しない）

OpenClaw Gateway の WS は RPC フレーム形式。
サーバーはまず `connect.challenge` を受け取り、署名付きの `connect` リクエストを返す。

```
Gateway → { "type": "event", "event": "connect.challenge", "payload": { "nonce": "…" } }
Client → { "type": "req", "method": "connect", "params": { "auth": {"token":"…"}, "device": {"signature":"…","nonce":"…"}, … } }
Gateway → { "type": "res", "ok": true, "payload": { "type": "hello-ok" } }

Client → { "type": "req", "method": "chat.send", "params": { "sessionKey":"agent:main:main", "message":"…", "deliver": false, "idempotencyKey":"…" } }
Gateway → { "type": "event", "event": "chat", "payload": { "state": "delta", "runId": "…", "message": { … } } }
Gateway → { "type": "event", "event": "chat", "payload": { "state": "final", "runId": "…", "message": { … } } }
```

---

## ファイル構成

```
png-asistant/
├── server.js          Node.js サーバー（Express + WebSocket + Gateway client）
├── package.json       依存パッケージ定義
├── public/
│   ├── index.html     表示ページ（チャット UI を含む）
│   ├── style.css      スタイル
│   └── app.js         アニメーション・音声・パーティクル・チャット UI
└── images/
    ├── background.png
    ├── normal.png
    ├── closed.png
    ├── half.png
    ├── smile.png
    └── mouth.png
```
