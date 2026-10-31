=== DisplayXR 3D Photos ===
Contributors: displayxr
Tags: 3d, stereo, stereoscopic, photography, side-by-side
Requires at least: 5.8
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.1.0
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

Show side-by-side stereo photos in glasses-free 3D on a 3D display. Every other visitor sees a normal photo.

== Description ==

Put a side-by-side (SBS) stereo photo on any post or page. Visitors using the DisplayXR Browser on a
glasses-free 3D display see it in 3D. Everyone else (phones, ordinary laptops, any other browser)
sees a normal, single photo at the right shape, never the squeezed pair.

Use the shortcode:

`[dxr3d src="https://example.com/wp-content/uploads/2026/10/canyon_2x1.jpg"]`

or add the **3D Photo** block in the block editor and pick the picture from your media library.

Attributes:

* `src` (required): the address of the side-by-side JPEG/PNG. Pictures from your own media library work best.
* `layout`: `parallel` (default, left eye on the left) or `cross` (cross-eyed pairs, right eye on the left).
* `alt`: a description for screen readers. For media-library pictures, the alt text from the library is used when this is empty.
* `caption`: text shown under the photo.
* `width`: maximum width, e.g. `600` (pixels) or `80%`. Default: the full width of your content column.

The 3D is drawn by the DisplayXR web SDK (`@displayxr/inline3d` 1.47.4), loaded from the jsDelivr CDN
only on pages that contain a 3D photo.

== Installation ==

1. In WordPress Admin go to Plugins > Add New Plugin > Upload Plugin.
2. Choose `displayxr-3d-photos.zip`, click Install Now, then Activate.
3. Add `[dxr3d src="..."]` or the 3D Photo block to a post or page.

== Frequently Asked Questions ==

= I see a normal photo, not 3D =

That is expected in every browser except the DisplayXR Browser running on a 3D display.

= My picture comes from another website =

It usually works, but some sites block their images from being shown on other sites ("hotlink
protection"). If the picture does not appear at all, upload it to your own media library instead.

= I use a caching or "optimize JavaScript" plugin =

If 3D stops working, exclude `displayxr-3d-photos/assets/dxr3d.js` and `cdn.jsdelivr.net` from
JavaScript combining, minifying and delaying. The script is an ES module and must keep `type="module"`.

== Changelog ==

= 0.1.0 =
* First version: `[dxr3d]` shortcode and 3D Photo block.
