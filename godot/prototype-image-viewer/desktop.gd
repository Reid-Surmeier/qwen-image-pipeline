extends Control
# Screenshot placements in the layout reference's 1944 x 1280 review coordinates.
const PANELS := [
	["equipment", Rect2(12, 20, 482, 254)],
	["options", Rect2(12, 291, 493, 213)],
	["filters", Rect2(12, 522, 508, 231)],
	["status", Rect2(0, 762, 499, 63)],
	["trade", Rect2(12, 828, 492, 213)],
	["chat", Rect2(6, 1050, 505, 230)],
	["party", Rect2(530, 709, 319, 312)],
	["bottom", Rect2(519, 1221, 1403, 54)],
]
var panels: Array[TextureRect] = []
var album_label := Label.new()

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	for entry in PANELS:
		var panel := TextureRect.new()
		panel.name = entry[0]
		var texture: Texture2D
		if entry[0] == "filters":
			var layout: Texture2D = load("res://assets/layout-reference.png")
			texture = ImageTexture.create_from_image(layout.get_image().get_region(Rect2i(13, 550, 535, 245)))
		else:
			texture = load("res://assets/" + entry[0] + ".png")
		panel.texture = texture
		panel.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
		var material := ShaderMaterial.new()
		material.shader = preload("res://remove-pink.gdshader")
		if entry[0] == "filters": material.set_shader_parameter("border_width", 3.0)
		panel.material = material
		add_child(panel)
		panels.append(panel)
	album_label.text = "2ND ALBUM"
	album_label.add_theme_color_override("font_color", Color.BLACK)
	album_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(album_label)

func arrange(available: Vector2) -> void:
	var factor := minf(available.x / 1944.0, available.y / 1280.0)
	for index in panels.size():
		var rect: Rect2 = PANELS[index][1]
		panels[index].position = rect.position * factor
		panels[index].size = rect.size * factor
	album_label.position = Vector2(1628, 608) * factor
	album_label.add_theme_font_size_override("font_size", maxi(10, roundi(42 * factor)))

func snapshot() -> Array:
	var result := []
	for panel in panels:
		result.append({"name": panel.name, "rect": [panel.position.x, panel.position.y, panel.size.x, panel.size.y]})
	return result
