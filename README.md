# PNG アシスタント表示システム

音声に反応して口パク・瞬きするWeb表示アシスタント。
外部システム（TTSなど）からHTTP POSTで音声データを受信し、ブラウザ上でリアルタイム再生しながらキャラクターアニメーションを行う。

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

### 3. サーバー起動

```bash
node server.js
```

デフォルトはポート3000。変更する場合は環境変数で指定する。

```bash
PORT=8080 node server.js
```

### 4. ブラウザで開く

```
http://localhost:3000
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
| `WS` | `ws://localhost:3000` | ブラウザとの双方向通信 |

### WebSocket メッセージ形式（サーバー → ブラウザ）

```json
{ "type": "audio",      "data": "<base64>", "mimeType": "audio/wav" }
{ "type": "expression", "value": "normal" }
{ "type": "expression", "value": "smile"  }
```

---

## ファイル構成

```
png-asistant/
├── server.js          Node.js サーバー（Express + WebSocket）
├── package.json       依存パッケージ定義
├── public/
│   ├── index.html     表示ページ
│   ├── style.css      スタイル
│   └── app.js         アニメーション・音声処理・パーティクル
└── images/
    ├── background.png
    ├── normal.png
    ├── closed.png
    ├── half.png
    ├── smile.png
    └── mouth.png
```
