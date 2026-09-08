shader_type canvas_item;
render_mode unshaded;
uniform float border_width = 32.0;

void fragment() {
	vec4 pixel = texture(TEXTURE, UV);
	// Key only the outer 32 source pixels, preserving pink artwork inside windows.
	vec2 edge = min(UV, vec2(1.0) - UV) / TEXTURE_PIXEL_SIZE;
	float magenta = min(pixel.r, pixel.b) - pixel.g;
	if (min(edge.x, edge.y) < border_width && magenta > 0.025) {
		pixel.a = 0.0;
	}
	COLOR = pixel;
}
