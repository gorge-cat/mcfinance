# Visual assets

## Generated decorative hero

- Asset: `public/assets/food/hero-feast.png`
- Use: decorative food imagery for the McFinance hero, displayed over a CSS background.
- Source: created with the built-in `image_gen__imagegen` tool on 2026-10-24. This is AI-generated decorative imagery, not an official product photograph or a statement of product availability, ingredients, or pricing.
- Contents: a double cheeseburger, red fries carton, and vanilla waffle cone in a compact composition. Packaging contains no text or logo.
- Format: PNG, 1254 × 1254 px, 32-bit ARGB with actual transparent background; 1,991,852 bytes.
- Validation: visually inspected using `view_image`; checked image dimensions, 32-bit alpha format, transparent corner, and non-opaque pixel samples. All food silhouettes fit within the image.
- Delivery: copied the generated artifact into the project; original generated image retained under the Codex generated-images directory.
- Implementation: use the PNG directly and preserve alpha. The application supplies the warm yellow background.

### Final generation prompt

```text
Use case: ads-marketing
Asset type: transparent PNG hero image for the right half of a warm buttery-yellow finance app hero
Primary request: highly polished delicious photoreal studio product composition of three food objects in a close cluster: a sesame double cheeseburger largest at center front; a simple red french fries carton behind on the left; and a vanilla soft-serve waffle cone tilted slightly right on the right.
Scene/backdrop: completely transparent background with true alpha, isolated cutout; the application supplies its own background.
Style/medium: premium dimensional food advertising photography with believable food proportions, 3/4 view, crisp appetizing textures.
Composition/framing: balanced compact cluster with generous transparent margin around every object and no clipping; burger front and dominant, fries behind left, cone behind right; square asset suitable for a broad hero composition.
Lighting/mood: soft natural contact shadows, warm premium studio key light, gentle highlights and rich dimensional form.
Color palette/materials: golden sesame bun, juicy browned beef, melting yellow cheese, crisp fresh green lettuce, golden crisp fries, simple bright red McDonald's-inspired carton without lettering, white creamy ice cream and golden waffle texture.
Constraints: exactly these three main objects; actual transparent background, no yellow backdrop, no plate, no table, no floor, no border, no text, no lettering, no watermark, no faces, no hands, no mascot; preserve all food edges and cone tip within frame.
```

