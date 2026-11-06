# Weather Globe

手元で回せる地球儀で、天気と世界を眺めるデスクトップアプリです。設定した場所の天気と予報を表示し、雲や風の流れを地球儀の上に表示します。地表へ寄って都市を巡ったり、太陽系まで引いたりもできます。

2026-11-05 に Weather News から Tiny Earth に、2026-11-06 に Blue Globe に、同じ日に Weather Globe に名前を変えました。
## 起動

`start.bat` を実行します。初回は `.venv` と `node_modules` の作成、ビルドも行います。ソースがビルドの出力より新しいとき(`git pull` の後など)も、起動の前にビルドし直します(判定は `scripts/needs-build.mjs`)。

必要なもの:

- Windows、Node.js、Python 3.13(`py -3.13`)

## 使い方

1. 初回は設定が開くので、地名を検索して場所を選びます。
2. 地球儀がその場所へ寄り、左上に今の天気、左下に24時間と週間の予報が表示されます。15分ごとに更新します。各パネルは見出しで開閉できます。
3. 右下のボタンで地図の表示を切り替えます。「通常」は回して触れる地球と星、太陽、月、「天気」はそこに衛星画像をもとにした雲を重ねた表示、「風速」は風の流れです。ドラッグで回転、ホイールで拡大でき、「ホームへ戻る」で設定した場所に戻ります。
4. 右下の「地域」で、その場所を斜めから見下ろす視点に切り替えます。左ドラッグで回転と傾き、右ドラッグで移動、ホイールで拡大縮小です。W を押している間は巡航が速くなり、S を押している間は遅くなって止まります。手を離すとその速さで飛び続けます(設定の「カメラ」で、W/S を 1 回押すごとに 1 段変わる段階式にもできます)。A/D で向きを変えます。Q/E で中心のまわりを回り、矢印キーでその向きにある次の都市へ移ります。風速モードでは使えません。
5. 地球儀の上の都市のラベルをクリックすると、その都市の天気と現地時刻に切り替わります。「ホームへ戻る」で設定した場所に戻ります。ラベルは設定の「グラフィックス」でオフにできます。
6. 左上のスライダーで 24 時間前までさかのぼれます。止めるとその時刻の雲、風、天気に切り替わり、右端まで動かすと元に戻ります。
7. 右上の再生のアイコンでデモが始まり、地球の回転と地域ビューを自動で順に見られます。地球のクリックかキー操作、もう一度アイコンを押すと終わります。
8. F12 でスクリーンショットを撮ります。Shift+F12 は Windows の表示倍率が 100% のときの大きさで保存します。右下の通知をクリックすると保存先を開きます。

## 開発

```bash
npm run build   # 型チェックとビルド
npm start       # 起動
npm test        # 単体テスト(Python と Node)
```

画面側(`src/renderer/`)の変更は、`npm run build:renderer` のあとアプリで Ctrl+R を押すと、再起動せずに反映できます。`npm run watch:renderer` を動かしておくと、保存のたびに自動でビルドされます。`src/main/` の変更は `npm run build` と再起動が必要です。

構成と方針は [docs/plan/plan.md](docs/plan/plan.md)、進捗は [docs/plan/progress.md](docs/plan/progress.md) を参照してください。

## 保存先

`data/` に設定(`settings.json`)、風データのキャッシュ、ログ、スクリーンショット(`screenshots/`)、地域ビューの高解像度の画像(`earth-tiles/`)を保存します。Git 管理外です。`earth-tiles/` は自動では消えませんが、消しても次に表示するときに取り直します。

## データの出典

- 天気: [Open-Meteo](https://open-meteo.com/)(CC BY 4.0、無料枠は非商用)
- 地名検索: 国土地理院、Open-Meteo
- 風: NOAA GFS
- 雲: NOAA GMGSI(衛星の全球合成画像)と NOAA GFS をもとに加工したもの(元データそのものではありません)
- 海岸線と国境線: Natural Earth
- 標高: AWS Terrain Tiles(Mapzen。SRTM、GMTED2010、ETOPO1 などから作られたもの)。地形の陰を付けるときだけ取得する
- 地表と街明かりの画像: NASA Blue Marble / Black Marble(地表は、地球ビューと陰影なしの設定が Blue Marble Next Generation、陰影ありの設定が Blue Marble Shaded Relief and Bathymetry)。We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).
- 星と星座の線: Hipparcos カタログ由来の星と、星座の線のデータを [d3-celestial](https://github.com/ofrohn/d3-celestial) から変換(ライセンスは [assets/licenses/d3-celestial-LICENSE.txt](assets/licenses/d3-celestial-LICENSE.txt))
