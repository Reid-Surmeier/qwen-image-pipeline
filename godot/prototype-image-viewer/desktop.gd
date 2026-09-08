extends Control
# Screenshot placements in the layout reference's 1944 x 1280 review coordinates.
const PANELS := [
	["equipment", Rect2(12, 20, 482, 254), 30],
	["options", Rect2(12, 291, 493, 213), 30],
	["filters", Rect2(12, 522, 508, 231), 32],
	["status", Rect2(0, 762, 499, 63), 31],
	["trade", Rect2(12, 828, 492, 213), 31],
	["chat", Rect2(6, 1050, 505, 230), 29],
	["party", Rect2(530, 709, 319, 312), 38],
	["bottom", Rect2(519, 1221, 1403, 54), 54],
]
var panels: Array[TextureRect] = []

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
		panel.mouse_filter = Control.MOUSE_FILTER_STOP
		var material := ShaderMaterial.new()
		material.shader = preload("res://remove-pink.gdshader")
		if entry[0] == "filters": material.set_shader_parameter("border_width", 3.0)
		panel.material = material
		add_child(panel)
		panels.append(panel)

func arrange(available: Vector2) -> void:
	var factor := minf(available.x / 1944.0, available.y / 1280.0)
	for index in panels.size():
		var rect: Rect2 = PANELS[index][1]
		panels[index].position = rect.position * factor
		panels[index].size = rect.size * factor
		panels[index].set_meta("drag_height", PANELS[index][2] * factor)

func snapshot() -> Array:
	var result := []
	for panel in panels:
		result.append({"name": panel.name, "rect": [panel.position.x, panel.position.y, panel.size.x, panel.size.y], "order": panel.get_index()})
	return result
