# Development notes

- Google Keep attachment URLs may not include file extensions. Image downloads infer common image formats from their
  bytes before writing into `media/`, so Obsidian can render their managed embeds.
- Imported image embeds are opt-in through `embedImportedImages`; managed embed blocks are excluded from duplicate and
  merge comparisons.
