/* DisplayXR 3D Photos: the "3D Photo" block for the block editor. Plain JS, no build step.
 * The block saves nothing but its settings; the page is rendered by the same PHP as the
 * [dxr3d] shortcode, and the editor shows that rendering (the flat photo) as its preview. */
( function ( wp ) {
	var el = wp.element.createElement;
	var Fragment = wp.element.Fragment;
	var __ = wp.i18n.__;
	var be = wp.blockEditor;
	var c = wp.components;
	var ServerSideRender = wp.serverSideRender;

	wp.blocks.registerBlockType( 'displayxr/stereo-photo', {
		apiVersion: 2,
		title: __( '3D Photo', 'displayxr-3d-photos' ),
		description: __( 'A side-by-side stereo photo, in glasses-free 3D on a 3D display and a normal photo everywhere else.', 'displayxr-3d-photos' ),
		category: 'media',
		icon: 'format-image',
		keywords: [ '3d', 'stereo', 'displayxr', 'sbs' ],
		attributes: {
			id: { type: 'number', default: 0 },
			src: { type: 'string', default: '' },
			layout: { type: 'string', default: 'parallel' },
			alt: { type: 'string', default: '' },
			caption: { type: 'string', default: '' },
			width: { type: 'string', default: '' },
		},
		supports: { html: false },

		edit: function ( props ) {
			var a = props.attributes;
			var set = props.setAttributes;
			var blockProps = be.useBlockProps ? be.useBlockProps() : {};

			function onSelect( media ) {
				if ( ! media || ! media.url ) return;
				set( { id: media.id || 0, src: media.url, alt: a.alt || media.alt || '' } );
			}

			if ( ! a.src ) {
				return el( 'div', blockProps,
					el( be.MediaPlaceholder, {
						icon: 'format-image',
						labels: {
							title: __( '3D Photo', 'displayxr-3d-photos' ),
							instructions: __( 'Choose a side-by-side stereo photo (left eye on the left) from your media library, upload one, or paste its web address.', 'displayxr-3d-photos' ),
						},
						accept: 'image/*',
						allowedTypes: [ 'image' ],
						onSelect: onSelect,
						onSelectURL: function ( url ) { set( { id: 0, src: url } ); },
					} )
				);
			}

			return el( Fragment, null,
				el( be.InspectorControls, null,
					el( c.PanelBody, { title: __( '3D photo settings', 'displayxr-3d-photos' ) },
						el( c.SelectControl, {
							label: __( 'Which eye is on the left?', 'displayxr-3d-photos' ),
							value: a.layout,
							options: [
								{ label: __( 'Left eye on the left (parallel, most common)', 'displayxr-3d-photos' ), value: 'parallel' },
								{ label: __( 'Right eye on the left (cross-eyed)', 'displayxr-3d-photos' ), value: 'cross' },
							],
							onChange: function ( v ) { set( { layout: v } ); },
						} ),
						el( c.TextControl, {
							label: __( 'Description for screen readers (alt text)', 'displayxr-3d-photos' ),
							value: a.alt,
							onChange: function ( v ) { set( { alt: v } ); },
						} ),
						el( c.TextControl, {
							label: __( 'Caption', 'displayxr-3d-photos' ),
							value: a.caption,
							onChange: function ( v ) { set( { caption: v } ); },
						} ),
						el( c.TextControl, {
							label: __( 'Maximum width (e.g. 600 or 80%; empty = full width)', 'displayxr-3d-photos' ),
							value: a.width,
							onChange: function ( v ) { set( { width: v } ); },
						} ),
						el( c.Button, {
							variant: 'secondary',
							isSecondary: true,
							onClick: function () { set( { id: 0, src: '' } ); },
						}, __( 'Choose a different photo', 'displayxr-3d-photos' ) )
					)
				),
				el( 'div', blockProps,
					el( ServerSideRender, { block: 'displayxr/stereo-photo', attributes: a } )
				)
			);
		},

		save: function () {
			return null; // rendered by PHP
		},
	} );
} )( window.wp );
