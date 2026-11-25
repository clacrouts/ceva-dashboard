# CEVA (Coastal Erosion and Vulnerability Application): the dashboard

A public map of how Europe's beaches have moved since 1984, transect by transect, from Landsat and
Sentinel-2 images corrected for tide and waves. It is a static site: precomputed files read straight
from the host, no server, so it is free to host and fast everywhere.

The data are made by the [CEVA software](https://github.com/clacrouts/ceva) (`ceva publish`), whose README and
step-by-step notebook describe how every metric is computed, and published on Zenodo
([doi:10.5281/zenodo.24493619](https://doi.org/10.5281/zenodo.24493619)), with the satellite images behind them
([doi:10.5281/zenodo.24500960](https://doi.org/10.5281/zenodo.24500960)). This repository shows them.

## What is in it

| Path | What |
|---|---|
| `validation.html`, `assets/validation*.{js,css}` | How CEVA compares: against field surveys at six beaches (with the published algorithms of the SDS benchmark) and against the Shoreline Monitor and EMODnet's satellite and field data, with what CEVA adds and its limits; charts drawn from `data/validation.json` |
| `index.html`, `assets/` | The site: [MapLibre GL JS](https://maplibre.org/) map, [PMTiles](https://protomaps.com/docs/pmtiles) vector tiles, [uPlot](https://github.com/leeoniya/uPlot) charts. Filters (country, change, coastal type, material, built-up or defended shore, precision, significant trends) act on the map and on the figures; a summary by country (sortable table) follows the filters, and each country opens its profile (how its coast has changed, where, and how far to trust the numbers there: field surveys, precision of the yearly positions, agreement with the other products, each against Europe as a whole; `assets/country.js`); each transect's card gives its rate ± half its 95 % range. When the publication has the coastal vulnerability index (`ceva vulnerability compute`), the map opens coloured by its class (the other colourings stay in the menu), the card shows the index with its six ranks and the values behind them, and the country profile compares its classes with the whole coast. Libraries load from jsDelivr at pinned versions; the basemap is [OpenFreeMap](https://openfreemap.org/) (OpenStreetMap data, no key). |
| `assets/languages.js`, `assets/i18n/` | Ten languages: English, French, German, Spanish, Italian, Portuguese, Romanian, Chinese (simplified), Hindi and Arabic (right to left). One file per page and language (`map-<code>.js`, `report-<code>.js`), loaded when chosen; a missing text falls back to English. Numbers and country names follow the language (the browser's `Intl`). |
| `data/manifest.json` | What was published: date, CEVA version, method, transects, years, extent, licence, attributions |
| `data/summary.json` | Totals by change class (and by vulnerability class, when published), for all coasts and each country (the overview panel) |
| `data/stats.json` | The transects grouped by what the filters look at, with their rates (cm/yr): the filtered figures and the summary by country, exact for any choice of filters (about 0.4 MB, 0.2 MB compressed) |
| `data/coverage.pmtiles` | The coast of the area that the data do not measure (`ceva publish --area`), as lines along it: other coast types (rock, cliffs and structures, mud; dashed grey) and sand or gravel where no shoreline could be measured (ochre). Pointing at one says why. |
| `data/shoreline.pmtiles` | One point per transect at its latest shoreline position: rate of change (m/yr) and its 95 % range, change class (Luijendijk et al. 2018), precision, coastal type, built-up and defended shores, the Deltares Shoreline Monitor's rate |
| `data/series/<unit>.json` | Yearly shoreline positions of the transects of one processing unit, fetched when one is clicked, with the ranks and inputs of their vulnerability index |
| `data/refs/<unit>.json` | Where other products cover a transect: their rate, years and class, and CEVA's rate over the same years (the card's "Compared with other products") |
| `data/validation.json` | The validation page's numbers and chart data; says whether the run was finished when it was made |
| `assets/viewer.{js,css}`, `frames.html`, `assets/frames.{js,css}` | The satellite images behind the shorelines: in a transect's card (button under the chart; a click on the chart opens the images of a year, each image a dot), drawn in place on the map, or on a full page (`frames.html`). Over each image, the waterline CEVA detected (magenta, dashed), the shoreline after its tide and wave correction (red) and the year's position (black, dotted); or, with "Every year", the position of every year at once, coloured from dark blue (1984) to yellow (2025) with matplotlib's plasma colour map, the image's own year edged in white; pointing at a line, on the image or on the map, names its year. Reads a unit's index (`frames/units/<unit>.json`) when one of its transects is opened, then one segment's video and lines by HTTP range requests from its country's ZIP, local or on Zenodo. |
| `frames/` | The index of the image archive (`ceva frames pack`): `index.json` (the units with images) and `units/<unit>.json` (where each segment's video and lines start in its country's ZIP). The ZIPs themselves (22.5 GB) are on Zenodo; `archive_url` in `index.json` gives their address, and Zenodo's API serves byte ranges to other sites. The map's cards link to the images when `index.html` names the index (`<meta name="ceva-images">`); remove that line where no images are published. |
| `tools/serve.py` | Local preview server (answers HTTP range requests, which PMTiles needs) |
| `tools/check.py` | Headless-browser check: loads the site, opens a transect, switches language (French, Arabic, Chinese), filters the map, opens the summary by country and a country's profile, takes screenshots |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |

## Update the data

From a CEVA checkout with processed units:

```bash
ceva publish ../ceva-dashboard/data --run eu27-sand        # the finished units of a batch run
ceva publish ../ceva-dashboard/data --run eu27-sand,europe-sand,mediterranean-sand --area europe-mediterranean   # several runs, and the coast not measured
ceva publish ../ceva-dashboard/data --units truc_vert,...  # or named units and regions
ceva publish ../ceva-dashboard/data --run eu27-sand --only @area.txt   # a preview: these finished units only
```

Until the run is finished, the map shows a preview banner with the countries published, and the validation
page is marked provisional; both go when the data of the finished run are published.

This rewrites `data/` (map tiles with [tippecanoe](https://github.com/felt/tippecanoe), series, summary,
manifest, comparisons; run `ceva references prepare` once first for the comparisons). The sand and gravel
coasts of the EU (about 250 000 transects) come to roughly 400 MB: series about 240 MB, comparisons about
70 MB, map tiles about 70–80 MB. GitHub refuses files over 100 MB; `ceva publish` warns when the tiles get
close.
Every update adds that much to the repository's history; to keep it small, replace `data/` in a single
commit, or deploy from a build instead of the branch (see below).

## Preview

```bash
python tools/serve.py 8000          # then open http://localhost:8000/
python tools/check.py http://localhost:8000/ screenshots    # the map, a card, the validation page
```

## Host on GitHub Pages (free)

1. Create a public repository `ceva-dashboard` on GitHub and push this folder to its `main` branch.
2. Settings → Pages → Build and deployment: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. The site is then at `https://<user>.github.io/ceva-dashboard/` (a custom domain can be set there too).
4. To update it, publish again into `data/`, commit and push: the site follows within a few minutes (GitHub
   Pages lets browsers keep files for 10 minutes).

GitHub Pages serves byte ranges (needed by PMTiles) from a worldwide CDN. Its soft limits are a 1 GB site
and 100 GB of traffic a month; beyond that, Cloudflare Pages (unlimited traffic, 25 MiB per file, so the
tiles would be split by region) or an object store such as Cloudflare R2 can serve `data/` instead, with
the site unchanged (`DATA` in `assets/app.js`).

## Sources and licences

The published data are under CC-BY-4.0. They contain modified Copernicus Sentinel data (ESA / EU) and
Landsat imagery courtesy of the U.S. Geological Survey, and use the Global Coastal Transect System and the
Global Coastal Typology (Calkoen et al. 2025, CC-BY-4.0), the EOT20 tide model (Hart-Davis et al. 2021,
CC-BY-4.0) and ERA5 waves (Hersbach et al. 2020, Copernicus Climate Change Service). Map data © OpenStreetMap
contributors, OpenMapTiles, OpenFreeMap. The full list is in `data/manifest.json` and in the site's
"How to read this".

The site's code (everything but `data/`) is under the MIT licence (`LICENSE`); the data in `data/` are
under CC-BY-4.0, with the attributions above, except the values of the reference products in `data/refs/`,
which stay under their own licences: Shoreline Monitor (Global Coastal Typology) CC-BY-4.0, EMODnet Geology
coastline migration CC BY-SA 4.0.
