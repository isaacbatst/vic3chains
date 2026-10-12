# Runbook

How to update and publish the site. The options themselves are described in the [README](README.md).

The site is two pages built by the same generator: the vanilla graph at `/` and the Tech & Res graph at `/techres/`. Vercel publishes whatever is on `main`, so a push to `main` is a release.

## What you need

- Node.js 18 or newer.
- Victoria 3 installed (the generator reads the game files).
- A clone of the mod, kept outside this repository. Only a few folders are needed, so a sparse clone is enough:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/mattia2110/tech-and-res.git ../tech-and-res
git -C ../tech-and-res sparse-checkout set .metadata common/buildings common/building_groups common/goods common/production_methods common/production_method_groups common/technology localization gfx/interface/icons/building_icons gfx/interface/icons/goods_icons
```

## When the game or the mod updates

1. Update the mod clone.

```sh
git -C ../tech-and-res pull
```

2. Build the vanilla page. `--verify` checks three known recipes and fails if they changed.

```sh
node generate.cjs --verify --site . --variants "Vanilla=,Tech & Res=techres"
```

3. Build the Tech & Res page and list what still lacks a translation.

```sh
node generate.cjs --site techres --variants "Vanilla=,Tech & Res=techres" --mod ../tech-and-res --mod-url "https://steamcommunity.com/sharedfiles/filedetails/?id=3472248460" --url https://vic3chains.vercel.app/techres/ --todo all
```

4. Read the output of step 3:
   - `mod terms left in English` should be 0 for every language. If not, see "Translations" below.
   - `without icon` should list only the scenery monuments and `g:androids` (the mod points it to a file it does not ship). Anything else is a new icon format or a missing file.
   - `0 missing` in the `languages` line. A missing term has no name at all, not even in English.
   - A line starting with `--variants:` or `Mod folder not found` is an error; the page was not written.

5. Look at both pages before publishing. Any static server works:

```sh
npx serve .
```

   Check the graph draws, the menu in the top bar goes from one page to the other, the era menu goes up to the mod's last era on `/techres/`, and the help panel names the mod and its version.

6. Commit and push to `main`. Commit messages, file names and code are in English.

7. After a minute, check https://vic3chains.vercel.app/ and https://vic3chains.vercel.app/techres/.

## Translations

The mod ships its other languages as copies of the English text, so its terms are translated here, by machine, in `translations/tech.res/<language>.json`. Each file maps the English text to the translated text.

- Step 3 above writes `translations/tech.res/<language>.todo.json` with the English terms a language lacks. Those files are ignored by git.
- Add each missing term to the matching `<language>.json` and run step 3 again until every language is at 0.
- When the mod changes an English name, the old entry simply stops being used and the new name shows up in the todo list.
- Keep the word people actually use in each language. Many terms stay in English or as a loanword (data center, e-commerce, software, streaming); do not translate those.
- Many English names are ambiguous on their own ("A&R Operations" is autonomous and remote mining, "Stockpile" is the nuclear arsenal). Look the term up in the mod's `localization/english` and read its key before translating.
- A mod term with the same English text as a game term takes the game's own translation; nothing to do for those.

## Things that are easy to forget

- `techres/og.png` is the link-preview image of the mod page. The generator only warns when it is missing. Today it is a copy of the vanilla one.
- In `--variants`, folders are written without slashes ("Vanilla=,Tech & Res=techres"). Git Bash on Windows rewrites anything that looks like `/path` into a Windows path.
- The label in `--variants` must be the mod's name exactly as the generator prints it ("Tech & Res").
- `--save` never goes into `--site` builds. The public pages carry no save data.
- `preview.html` and `preview.<mod id>.html` are private fragments, ignored by git.

## The mod's author

The use of Tech & Res data and icons was announced in https://github.com/mattia2110/tech-and-res/issues/17, with a commitment: if the author asks for a different credit, for the icons to be left out or for the page to be taken down, it is done.

- To take the page down: delete the `techres` folder, rebuild the vanilla page without `--variants` (the menu disappears), push.
- To leave the mod's icons out: there is no option for it yet; it needs a change in `generate.cjs`.

## Adding another mod

1. Clone it next to this repository and build it into its own folder with `--mod`, as in step 3.
2. Add it to the `--variants` list of every page ("Vanilla=,Tech & Res=techres,Other Mod=othermod") and rebuild them all, so each menu lists the new page.
3. Run with `--todo all` and fill in `translations/<mod id>/`.
4. Ask or tell the author, as above, and add a section for it here.
