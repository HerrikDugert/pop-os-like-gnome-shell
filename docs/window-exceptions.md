# Window exception matching

A rule can set `match` to `exact` or `regex`.

- New rules created by selecting a running application/window use `exact`.
- Exact rules compare the entire string, case-sensitively. Regex punctuation is literal.
- A supplied empty title in an exact rule matches only an empty title.
- Existing rules without `match` remain case-insensitive JavaScript regex rules.
- `match: "regex"` explicitly selects the same legacy regex behavior.
- System exceptions remain regex rules. Toggling them does not remove exact user rules.
- The dialog labels user rules as `[Exact]` or `[Regex]` and removes only that mode.
- Rule order remains unchanged: the first matching user rule wins, followed by system defaults.
  Overlapping rules can therefore override one another; no automatic precedence change is made.
- Existing rules are not migrated. A legacy regex rule can coexist with a new exact rule.
- Invalid modes are rejected. This change does not make arbitrary regex rules safe from expensive matching.

Exact example:

```json
{ "class": "Example.App", "title": "Project [test]", "match": "exact" }
```

Explicit regex example (can be edited in the configuration file):

```json
{ "class": "^Example[.]App$", "title": "^Project.*", "match": "regex" }
```

The dialog does not provide a new regex editor or mode-conversion control.
After changing the source, compile both projects:

```sh
npx --no-install tsc --project tsconfig.json
npx --no-install tsc --project src/floating_exceptions/tsconfig.json
```

Run config and matching tests with the config loader; run executor tests separately
with the GLib executor loader. The matching tests mock file I/O and selected GTK
widgets. They do not start GNOME Shell or a real GTK dialog.
