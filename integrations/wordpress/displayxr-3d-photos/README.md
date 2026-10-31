# DisplayXR 3D Photos (WordPress plugin)

Put your side-by-side stereo photos on your WordPress site. People looking at your site in the
**DisplayXR Browser on a glasses-free 3D display** see them in 3D. Everyone else (phones, ordinary
computers, any other browser) sees a normal single photo, never the squeezed pair.

## What you need

- A WordPress site where you can install plugins. On a self-hosted WordPress site you always can.
  On **WordPress.com**, plugins need a **paid** plan; the free plan cannot install plugins
  ([WordPress.com: install a plugin](https://wordpress.com/support/plugins/install-a-plugin/)).
- The file `displayxr-3d-photos.zip`. Do **not** unzip it.
- Your photos as side-by-side pairs: one JPEG (or PNG) holding both views next to each other, the
  **left eye on the left** half. A 3000 x 1500 file, for example, is two 1500 x 1500 views.

## Install (once)

1. Log in to your site's admin (usually `https://your-site.com/wp-admin`).
2. In the black menu on the left, click **Plugins**, then the **Add New Plugin** button at the top.
3. Click **Upload Plugin** (top of the page). A box appears with a **Choose File** button.
4. Choose `displayxr-3d-photos.zip`, then click **Install Now**.
5. When it says "Plugin installed successfully", click **Activate Plugin**.

That is all. Nothing to configure.

## Add a 3D photo to a page

First upload the photo as usual: **Media > Add New Media File**. Open it in the media library and
copy its **File URL** (there is a "Copy URL to clipboard" button).

### Option A: the 3D Photo block (easiest)

1. Edit a post or page. Click the blue **+** (top left) and type `3D Photo`.
2. Click the **3D Photo** block. Choose **Media Library** and pick your photo (or **Upload** a new one).
3. In the panel on the right you can set: which eye is on the left, a description for blind
   visitors, a caption, and a maximum width.
4. Click **Update** or **Publish**.

### Option B: the shortcode

Add a **Shortcode** block (click **+** and type `shortcode`), or type straight into the page:

```
[dxr3d src="https://your-site.com/wp-content/uploads/2026/10/canyon_2x1.jpg"]
```

With every option:

```
[dxr3d src="https://your-site.com/wp-content/uploads/2026/10/canyon_2x1.jpg" layout="cross" alt="Sunrise over the canyon" caption="Grand Canyon, October" width="600"]
```

| option | what it does | example |
|---|---|---|
| `src` | **Required.** The address of the side-by-side photo. | `src="https://…/canyon_2x1.jpg"` |
| `layout` | `parallel` (the default: left eye on the left) or `cross` (cross-eyed pairs: right eye on the left). If the 3D looks inside-out, switch it. | `layout="cross"` |
| `alt` | A description for people who cannot see the photo. Photos from your media library use their library "Alternative Text" when you leave this out. | `alt="Sunrise over the canyon"` |
| `caption` | Text shown under the photo. | `caption="Grand Canyon"` |
| `width` | The largest the photo may be. A number is pixels; `%` is a share of the text column. Without it, the photo fills the text column. | `width="600"`, `width="80%"` |

You can put as many 3D photos on one page as you like.

If you forget `src`, visitors see nothing, and only you (while logged in) see a red reminder box.

## Good to know

- **To check it works**, open the page in any normal browser: you should see one clean photo, the
  right shape. The 3D itself only appears in the DisplayXR Browser on a 3D display.
- **Use your own media library.** Photos from other websites usually work, but some sites block
  their pictures from being shown elsewhere. If a photo does not appear at all, upload it to your
  media library instead.
- **WordPress shrinks very large uploads** to 2560 pixels wide (it keeps your original too). For a
  side-by-side pair that means each eye is about 1280 pixels wide, which is plenty on screen.
- **Caching / "speed" plugins** (WP Rocket, Autoptimize, LiteSpeed Cache, …): if the 3D stops
  working, tell the plugin not to combine, minify or delay
  `wp-content/plugins/displayxr-3d-photos/assets/dxr3d.js`, and not to touch `cdn.jsdelivr.net`.
  The photos still show normally either way.
- **The 3D code comes from jsDelivr**, a free public code server, and only on pages with a 3D
  photo. If a visitor's network blocks it, they simply see the normal photo.
- **Don't add effects to the photo** with your theme or page builder (rounded corners, shadows,
  fades, filters, animations). They stop the 3D. A plain photo is what works.

## For developers

- Build the zip: `./integrations/wordpress/build.sh` writes
  `integrations/wordpress/dist/displayxr-3d-photos.zip`.
- The SDK (`@displayxr/inline3d`) is pinned to an exact version in `displayxr-3d-photos.php`
  (`DXR3D_SDK_VERSION`), loaded as
  `https://cdn.jsdelivr.net/npm/@displayxr/inline3d@<version>/js/inline3d.js`.
- `assets/dxr3d.js` follows [`docs/woven-canvas-rules.md`](../../../docs/woven-canvas-rules.md):
  one shared session for the page, the flat photo kept on top of the woven canvas until
  `handle.firstWoven`, then a hard cut; `rectCover: 'auto'` for later resizes.
- The flat photo is pure CSS (the pair drawn 200% wide in an `overflow: hidden` box), so it
  needs no JavaScript and is what every non-DisplayXR browser shows.
