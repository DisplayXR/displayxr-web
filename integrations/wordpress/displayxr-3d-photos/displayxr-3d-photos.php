<?php
/**
 * Plugin Name:       DisplayXR 3D Photos
 * Plugin URI:        https://github.com/DisplayXR/displayxr-web/tree/main/integrations/wordpress
 * Description:       Show side-by-side stereo photos in glasses-free 3D on a 3D display (DisplayXR Browser). Everyone else sees a normal photo. Use the [dxr3d src="..."] shortcode or the "3D Photo" block.
 * Version:           0.1.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            DisplayXR
 * Author URI:        https://displayxr.github.io/displayxr-web/
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       displayxr-3d-photos
 *
 * @package DisplayXR_3D_Photos
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'DXR3D_VERSION', '0.1.0' );

/*
 * The DisplayXR web SDK (@displayxr/inline3d), pinned to an exact published version on jsDelivr.
 * Pinned on purpose: a page never changes behaviour because the SDK shipped a new release. Bump it
 * here (and in readme.txt) after checking the new version on a 3D display.
 */
define( 'DXR3D_SDK_VERSION', '1.47.4' );
define( 'DXR3D_SDK_URL', 'https://cdn.jsdelivr.net/npm/@displayxr/inline3d@' . DXR3D_SDK_VERSION . '/js/inline3d.js' );

/**
 * Register the front-end assets. Nothing is enqueued here: they load only on pages that
 * actually contain a 3D photo (see dxr3d_maybe_enqueue_early() and dxr3d_render()).
 */
function dxr3d_register_assets() {
	$base = plugin_dir_url( __FILE__ ) . 'assets/';
	wp_register_style( 'dxr3d', $base . 'dxr3d.css', array(), DXR3D_VERSION );
	wp_register_script( 'dxr3d', $base . 'dxr3d.js', array(), DXR3D_VERSION, true );
	wp_register_script(
		'dxr3d-block-editor',
		$base . 'block.js',
		array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-i18n', 'wp-server-side-render' ),
		DXR3D_VERSION,
		true
	);
}
add_action( 'init', 'dxr3d_register_assets', 5 );

/**
 * The front-end script is an ES module (it imports the SDK). WordPress has no portable way to say
 * so on a classic script handle before 6.5's script-modules API, so mark the tag here.
 *
 * @param string $tag    The <script> tag.
 * @param string $handle Script handle.
 * @return string
 */
function dxr3d_module_tag( $tag, $handle ) {
	if ( 'dxr3d' !== $handle ) {
		return $tag;
	}
	$tag = preg_replace( '/\stype=(["\'])[^"\']*\1/', '', $tag );
	return str_replace( '<script ', '<script type="module" ', $tag );
}
add_filter( 'script_loader_tag', 'dxr3d_module_tag', 10, 2 );

/**
 * Enqueue the stylesheet in <head> when the main post already contains a 3D photo, so the flat
 * photo is cropped correctly from the very first paint. dxr3d_render() enqueues again as a
 * fallback (widgets, page builders), which is a no-op when this already ran.
 */
function dxr3d_maybe_enqueue_early() {
	if ( ! is_singular() ) {
		return;
	}
	$post = get_post();
	if ( ! $post ) {
		return;
	}
	$content = (string) $post->post_content;
	if ( has_shortcode( $content, 'dxr3d' ) || ( function_exists( 'has_block' ) && has_block( 'displayxr/stereo-photo', $post ) ) ) {
		wp_enqueue_style( 'dxr3d' );
		wp_enqueue_script( 'dxr3d' );
	}
}
add_action( 'wp_enqueue_scripts', 'dxr3d_maybe_enqueue_early' );

/**
 * Turn a width attribute into a safe CSS length. A bare number is pixels.
 *
 * @param string $width Raw value, e.g. "600", "600px", "80%".
 * @return string CSS length, or '' when absent/invalid.
 */
function dxr3d_css_width( $width ) {
	$width = trim( (string) $width );
	if ( '' === $width ) {
		return '';
	}
	if ( ! preg_match( '/^(\d+(?:\.\d+)?)(px|%|em|rem|vw)?$/i', $width, $m ) ) {
		return '';
	}
	$unit = isset( $m[2] ) && '' !== $m[2] ? strtolower( $m[2] ) : 'px';
	return $m[1] . $unit;
}

/**
 * Render one 3D photo. Shared by the shortcode and the block.
 *
 * Markup: a <figure> whose stage crops the side-by-side image to ONE eye with plain CSS (the
 * image is drawn 200% wide inside an overflow:hidden box). That flat photo is what every
 * browser shows, with or without JavaScript. In the DisplayXR Browser, dxr3d.js adds a woven
 * canvas under it and removes the flat photo once the browser reports the canvas woven.
 *
 * @param array $args { src, layout, alt, caption, width, id }.
 * @return string HTML.
 */
function dxr3d_render( $args ) {
	$args = wp_parse_args(
		$args,
		array(
			'src'     => '',
			'layout'  => 'parallel',
			'alt'     => '',
			'caption' => '',
			'width'   => '',
			'id'      => 0,
		)
	);

	$src = trim( (string) $args['src'] );
	$id  = absint( $args['id'] );
	if ( '' === $src && $id ) {
		$src = (string) wp_get_attachment_url( $id );
	}

	// Only http(s) URLs or site-relative paths; anything else (javascript:, data:, typos) is "missing".
	$src = esc_url_raw( $src, array( 'http', 'https' ) );

	if ( '' === $src ) {
		if ( current_user_can( 'edit_posts' ) ) {
			return '<p class="dxr3d-error" style="border:1px dashed #c00;padding:.5em 1em;color:#c00;">'
				. esc_html__( 'DisplayXR 3D Photo: no picture yet. Add src="https://…/photo.jpg" to the shortcode (only you see this message).', 'displayxr-3d-photos' )
				. '</p>';
		}
		return '<!-- dxr3d: missing src -->';
	}

	$layout = strtolower( trim( (string) $args['layout'] ) );
	$layout = in_array( $layout, array( 'cross', 'crossed', 'crosseyed', 'rl' ), true ) ? 'cross' : 'parallel';

	// A picture from this site's media library: use its stored size (no layout shift) and its alt text.
	if ( ! $id ) {
		$id = attachment_url_to_postid( $src );
	}
	$aspect = '';
	$alt    = (string) $args['alt'];
	if ( $id ) {
		$meta = wp_get_attachment_metadata( $id );
		if ( is_array( $meta ) && ! empty( $meta['width'] ) && ! empty( $meta['height'] ) ) {
			// The file's own size: attachment_url_to_postid() matches the original upload, never a resized copy.
			$aspect = ( (int) $meta['width'] / 2 ) . ' / ' . (int) $meta['height'];
		}
		if ( '' === $alt ) {
			$alt = (string) get_post_meta( $id, '_wp_attachment_image_alt', true );
		}
	}

	wp_enqueue_style( 'dxr3d' );
	wp_enqueue_script( 'dxr3d' );

	// The width goes on an inner box, so a percentage means "of the content column" and the
	// figure itself keeps whatever width the theme gives post content.
	$box_style = 'margin-left:auto;margin-right:auto;';
	$width     = dxr3d_css_width( $args['width'] );
	if ( '' !== $width ) {
		$box_style .= 'max-width:' . $width . ';';
	}
	$stage_style = 'position:relative;overflow:hidden;' . ( '' !== $aspect ? 'aspect-ratio:' . $aspect . ';' : '' );
	// Critical crop inline, so a theme's "img { max-width:100% }" can never show the squeezed pair.
	$img_style = 'display:block;width:200%;max-width:none;height:auto;margin:0;' . ( 'cross' === $layout ? 'margin-left:-100%;' : '' );

	$html  = '<figure class="dxr3d dxr3d-' . esc_attr( $layout ) . '"';
	$html .= ' data-dxr-src="' . esc_url( $src ) . '"';
	$html .= ' data-dxr-layout="' . esc_attr( $layout ) . '"';
	$html .= ' data-dxr-sdk="' . esc_url( DXR3D_SDK_URL ) . '"';
	$html .= '>';
	$html .= '<div class="dxr3d-box" style="' . esc_attr( $box_style ) . '">';
	$html .= '<div class="dxr3d-stage" style="' . esc_attr( $stage_style ) . '">';
	$html .= '<img class="dxr3d-flat" src="' . esc_url( $src ) . '" alt="' . esc_attr( $alt ) . '" decoding="async" loading="lazy" style="' . esc_attr( $img_style ) . '">';
	$html .= '</div>';
	if ( '' !== trim( (string) $args['caption'] ) ) {
		$html .= '<figcaption class="dxr3d-caption">' . esc_html( $args['caption'] ) . '</figcaption>';
	}
	$html .= '</div></figure>';
	return $html;
}

/**
 * [dxr3d src="https://…/pair.jpg" layout="parallel|cross" alt="…" caption="…" width="600"]
 *
 * @param array|string $atts Shortcode attributes.
 * @return string
 */
function dxr3d_shortcode( $atts ) {
	$atts = shortcode_atts(
		array(
			'src'     => '',
			'layout'  => 'parallel',
			'alt'     => '',
			'caption' => '',
			'width'   => '',
			'id'      => '',
		),
		is_array( $atts ) ? $atts : array(),
		'dxr3d'
	);
	return dxr3d_render( $atts );
}
add_shortcode( 'dxr3d', 'dxr3d_shortcode' );

/**
 * The "3D Photo" block: the same renderer, edited with a plain media picker. No build step.
 */
function dxr3d_register_block() {
	if ( ! function_exists( 'register_block_type' ) ) {
		return;
	}
	register_block_type(
		'displayxr/stereo-photo',
		array(
			'api_version'     => 2,
			'editor_script'   => 'dxr3d-block-editor',
			'editor_style'    => 'dxr3d',
			'attributes'      => array(
				'id'      => array(
					'type'    => 'number',
					'default' => 0,
				),
				'src'     => array(
					'type'    => 'string',
					'default' => '',
				),
				'layout'  => array(
					'type'    => 'string',
					'default' => 'parallel',
				),
				'alt'     => array(
					'type'    => 'string',
					'default' => '',
				),
				'caption' => array(
					'type'    => 'string',
					'default' => '',
				),
				'width'   => array(
					'type'    => 'string',
					'default' => '',
				),
			),
			'render_callback' => 'dxr3d_render',
		)
	);
}
add_action( 'init', 'dxr3d_register_block' );
