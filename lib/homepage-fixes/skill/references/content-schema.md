# content.json

Write it in the job folder, next to `before.jpg` and `photos/` from the capture. Full example:
`examples/gabby/content.json`.

```json
{
 "first_name": "Gabby",                 // printed on the PDF file name and image labels
 "website": "gabbyjphotography.com",
 "goal": "their answer to: What would you love your website to do for you?",
 "first_section": {
  "photo": "photos/photo-01.jpg",       // a real photo from their site (from capture)
  "photo_focus": "50% 35%",             // CSS background-position so faces stay in frame
  "layout": "left",                     // left | right | center | box (white box over the photo); put the words on the emptier side of the photo
  "nav_position": "top",                // top | bottom (match their site)
  "nav_style": "bar",                   // bar (solid strip) | over (white text over the photo)
  "nav_background": "#FFFFFF",          // optional, bar color
  "nav_color": "#222222",               // optional, bar text color
  "logo_image": "logo.png",             // optional, from capture; else logo_text
  "logo_text": "GABBY J",
  "nav_items": ["Home", "About", "Portfolio", "Contact"],
  "heading_font": "Cormorant Garamond", // a Google Font name; their site's heading font if it is one
  "heading_weight": 500,                // optional
  "body_font": "Manrope",
  "uppercase_headline": false,          // true if their headings are all caps
  "eyebrow": "",                        // optional small line above the headline
  "headline": "Your Friend With the Camera",
  "subline": "Graduation, couples, and wedding photographer in central and southeast Alabama",
  "button": "Reach Out",
  "accent": ""                          // optional filled button color from their site; empty = outline
 },
 "first_section_changes": ["note for line 1", "note for line 2", "note for line 3"],
 "fixes": [
  {"title": "...", "noticed": "...", "why": "...", "changes": ["...", "...", "..."]},
  {"title": "...", "noticed": "...", "why": "...", "changes": ["...", "...", "..."]}
 ],
 "notes_for_maggie": "Not printed. Where the headline came from, anything you couldn't verify.",
 "file_name": "optional, defaults to your-top-homepage-fixes-<first name>"
}
```

Plain text only in every field (no HTML). Straight or curly quotes are both fine. The build adds
the no-lonely-last-word spacing for you.
