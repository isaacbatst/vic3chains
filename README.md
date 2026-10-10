# Victoria 3 Production Graph

An interactive map of every production chain in Victoria 3: all buildings, all goods and every production method, on one page.

Live at https://vic3chains.vercel.app/ · source: https://github.com/isaacbatst/vic3chains

- Raw materials on the left, final products on the right.
- A filled block is a building (its color is the category); an icon with a label is a good.
- Hover a node to light up everything it is made of; click to pin it and open its sheet. With a node pinned you can pick the direction and reach of the chain, or isolate it.
- Each production method has a checkbox. With several methods ticked in one group, amounts become ranges (minimum to maximum across the ticked combinations). "Everything", "Basic" and "Late game" tick methods in every building at once.
- Pick the era your technologies go up to: anything beyond it is drawn dashed or faded.
- Filters hide building categories; the badge on the Filters button counts what differs from the default.
- Theme menu: light or dark, four neutral bases (Neutral, Stone, Zinc, Slate) and an optional accent color.
- 11 languages, taken from the game's own localization. The interface itself is in English and Brazilian Portuguese; other languages get English interface text with game terms in their language. Pin a language with an anchor: `#en`, `#pt`, `#es`, `#fr`, `#de`, `#pl`, `#ru`, `#tr`, `#ja`, `#ko`, `#zh`.

The whole site is `index.html` plus `og.png` (the link-preview image): one self-contained page, no build step, no server code. Fonts load from Google Fonts; everything else is inline. No ads, no cookies. Anonymous visit counts only (Vercel Web Analytics). What you tick and choose is stored in your own browser.

## Regenerating

You need Node.js 18 or newer and Victoria 3 installed. The generator reads the game files directly (buildings, production methods, goods, technologies, localization and icons), so the page always matches the installed version.

```sh
node generate.cjs --site .
```

That rewrites `index.html` in this folder. It also writes `preview.html` next to the script, a body-only fragment used for a private preview; it is not part of the site.

The game folder is the one that contains `common/`, `localization/` and `gfx/`. It is found in this order:

1. `--game <path>` on the command line
2. the `VIC3_GAME` environment variable
3. the default Steam path on Windows: `C:/Program Files (x86)/Steam/steamapps/common/Victoria 3/game`

```sh
node generate.cjs --site . --game "/path/to/Victoria 3/game"
```

Other options:

- `--url <url>` sets the public address used in the canonical link and in the link-preview tags (default: `https://vic3chains.vercel.app/`).
- `--no-analytics` leaves out the Vercel Web Analytics snippet. It is included by default in the `--site` build and only does anything when the site is hosted on Vercel with Web Analytics switched on; anywhere else the script request simply fails and the page works the same.
- `--verify` also checks three known recipes against the data just read and exits with an error if they differ.
- `--save <file.json>` takes `{ "label": "1860", "techs": ["enclosure", "..."] }` and adds a "My save" choice to the era menu, using that exact technology list. It only goes into the preview fragment, never into `index.html`.

Files:

- `generate.cjs`: the generator. It parses the game's script files, decodes the `.dds` icons and writes the page.
- `template.html`: the page itself (styles, markup, script). The generator fills in the data.
- `index.html`: the generated site.
- `og.png`: the 1200 x 630 image shown when the link is pasted somewhere. It is a screenshot of the page; the generator does not create it and only warns if it is missing.

## Disclaimer

This is a fan-made tool. It is not affiliated with, endorsed by or sponsored by Paradox Interactive. Victoria 3, its names and its icons are the property of Paradox Interactive AB. The data and icons on the page were read from an installed copy of the game (version 1.13.11 at the time of writing).

## License

The code in this repository is released under the [MIT License](LICENSE). That covers the generator and the page; it does not cover the game data, names and icons embedded in `index.html` and `og.png`, which belong to Paradox Interactive AB.
