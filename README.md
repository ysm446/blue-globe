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
3. 左上のボタンで地図の表示を切り替えます。「通常」は回して触れる地球と星、太陽、月、「天気」はそこに衛星画像をもとにした雲を重ねた表示、「風速」は風の流れです。ドラッグで回転、ホイールで拡大でき、「地点へ戻る」で設定地点に戻ります。
4. 左上の「地域」で、地点を斜めから見下ろす視点に切り替えます。左ドラッグで移動、右ドラッグで回転と傾き、ホイールで拡大縮小です。風速モードでは使えません。
5. モデルは「設定」の一覧から選びます。「使わない」も選べます。
6. F12 でスクリーンショットを撮ります。Shift+F12 は Windows の表示倍率が 100% のときの大きさで保存します。右下の通知をクリックすると保存先を開きます。

## 開発

```bash
npm run build   # 型チェックとビルド
npm start       # 起動
npm test        # ニュース文の単体テスト
```

構成と方針は [docs/plan/plan.md](docs/plan/plan.md)、進捗は [docs/plan/progress.md](docs/plan/progress.md) を参照してください。

## 保存先

`data/` に設定(`settings.json`)、風データのキャッシュ、ログ、スクリーンショット(`screenshots/`)、地域ビューの高解像度の画像(`earth-tiles/`)を保存します。Git 管理外です。`earth-tiles/` は自動では消えませんが、消しても次に表示するときに取り直します。

## データの出典

- 天気: [Open-Meteo](https://open-meteo.com/)(CC BY 4.0、無料枠は非商用)
- 解説文: [気象庁](https://www.jma.go.jp/bosai/)
- 地名検索: 国土地理院、Open-Meteo
- 風: NOAA GFS
- 雲: NOAA GMGSI(衛星の全球合成画像)と NOAA GFS をもとに加工したもの(元データそのものではありません)
- 海岸線と国境線: Natural Earth
- 地表と街明かりの画像: NASA Blue Marble / Black Marble。We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).
- 星: Hipparcos カタログ由来のデータを [d3-celestial](https://github.com/ofrohn/d3-celestial) から変換(ライセンスは [assets/licenses/d3-celestial-LICENSE.txt](assets/licenses/d3-celestial-LICENSE.txt))
