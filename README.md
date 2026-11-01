# Weather News

地球儀の上に風の流れを表示しながら、設定した地点の天気をニュース文で伝えるデスクトップアプリです。

## 起動

`start.bat` を実行します。初回は `.venv` と `node_modules` の作成、ビルドも行います。

必要なもの:

- Windows、Node.js、Python 3.13(`py -3.13`)
- `runtime/llama.cpp/llama-server.exe`(LLM を使う場合。Git 管理外)
- `D:\ai-models\llm` 内の GGUF モデル(LLM を使う場合。フォルダは設定で変更可)

LLM やモデルがなくても動きます。その場合、1文にまとめられない気象庁の文は原文のまま表示します。

## 使い方

1. 初回は設定が開くので、地名を検索して地点を選びます。
2. 地球儀が地点へ寄り、右のパネルにニュースが表示されます。15分ごとに更新します。
3. モデルは「設定」の一覧から選びます。「使わない」も選べます。

## 開発

```bash
npm run build   # 型チェックとビルド
npm start       # 起動
npm test        # ニュース文の単体テスト
```

構成と方針は [docs/plan/plan.md](docs/plan/plan.md)、進捗は [docs/plan/progress.md](docs/plan/progress.md) を参照してください。

## 保存先

`data/` に設定(`settings.json`)、風データのキャッシュ、ログを保存します。Git 管理外です。

## データの出典

- 天気: [Open-Meteo](https://open-meteo.com/)(CC BY 4.0、無料枠は非商用)
- 解説文: [気象庁](https://www.jma.go.jp/bosai/)
- 地名検索: 国土地理院、Open-Meteo
- 風: NOAA GFS
- 海岸線と国境線: Natural Earth
