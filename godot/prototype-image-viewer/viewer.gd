extends Control
# THROWAWAY: fixed-size artwork cards wrap as the window narrows.
# Frame patching and drag clamping follow the existing atlas prototype.
const SOURCE := preload("res://reference.png")
const CONTENT := Rect2(44, 156, 4500, 2404)
const ART_SCALE := 0.25
const WORKS := [
	Rect2(125, 200, 1215, 1240), # First print and its three original icon groups.
	Rect2(1374, 200, 763, 1118),
	Rect2(2174, 198, 833, 1126),
	Rect2(3030, 250, 1350, 1022),
	Rect2(125, 1493, 1215, 805),
	Rect2(2174, 1384, 1165, 932),
	Rect2(3475, 1276, 905, 1075),
]
var frame := Control.new()
var scroll := ScrollContainer.new()
var artwork := HFlowContainer.new()
var chrome := Control.new()
var border := StyleBoxFlat.new()
var hint := Label.new()
var pixel_scale := 0.2
var action := ""
var start_pointer := Vector2.ZERO
var start_rect := Rect2()

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	border.bg_color = Color.WHITE
	border.border_color = Color("8799a5")
	border.set_border_width_all(1)
	border.set_corner_radius_all(6)
	frame.draw.connect(func(): frame.draw_style_box(border, Rect2(Vector2.ZERO, frame.size)))
	add_child(frame)
	scroll.follow_focus = true
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_SHOW_NEVER
	var background := StyleBoxFlat.new()
	background.bg_color = Color.WHITE
	scroll.add_theme_stylebox_override("panel", background)
	frame.add_child(scroll)
	artwork.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	artwork.add_theme_constant_override("h_separation", 16)
	artwork.add_theme_constant_override("v_separation", 16)
	artwork.mouse_filter = Control.MOUSE_FILTER_IGNORE
	scroll.add_child(artwork)
	for region in WORKS:
		var atlas := AtlasTexture.new()
		atlas.atlas = SOURCE
		atlas.region = region
		var card := TextureRect.new()
		card.texture = atlas
		card.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		card.custom_minimum_size = region.size * ART_SCALE
		card.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
		card.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
		card.mouse_filter = Control.MOUSE_FILTER_IGNORE
		artwork.add_child(card)
	chrome.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chrome.draw.connect(_draw_frame)
	frame.add_child(chrome)
	add_child(hint)
	hint.add_theme_font_size_override("font_size", 13)
	hint.add_theme_color_override("font_color", Color("596775"))
	hint.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hint.text = "Scroll vertically · Drag title · Resize corner"
	get_viewport().size_changed.connect(_fit)
	_fit()

func _fit() -> void:
	var available := get_viewport_rect().size
	frame.position = Vector2(16, 16)
	frame.size = Vector2(minf(CONTENT.size.x * ART_SCALE + 30, available.x-32), minf(580, available.y - 66))
	_layout()

func _layout() -> void:
	pixel_scale = minf(0.25, (frame.size.x-10)/2150.0)
	scroll.position = Vector2(12, 12 + 102 * pixel_scale)
	scroll.size = frame.size - Vector2(24, 24 + 292 * pixel_scale)
	chrome.size = frame.size
	chrome.queue_redraw()
	frame.queue_redraw()
	hint.position = Vector2(16, get_viewport_rect().size.y - 30)
	_publish()

func _patch(source: Rect2, target: Rect2) -> void:
	if target.size.x > 0 and target.size.y > 0:
		chrome.draw_texture_rect_region(SOURCE, target, source)

func _draw_frame() -> void:
	var w := frame.size.x
	var h := frame.size.y
	var s := pixel_scale
	# Sample only the clean interior; the source's noisy outer frame is never drawn.
	_patch(Rect2(44, 34, 1800, 102), Rect2(5, 5, 1800*s, 102*s))
	_patch(Rect2(2000, 34, 1000, 102), Rect2(5+1800*s, 5, w-10-2150*s, 102*s))
	_patch(Rect2(4220, 34, 350, 102), Rect2(w-5-350*s, 5, 350*s, 102*s))
	var footer_y := h-5-190*s
	_patch(Rect2(44, 2580, 900, 190), Rect2(5, footer_y, 900*s, 190*s))
	_patch(Rect2(1000, 2580, 2000, 190), Rect2(5+900*s, footer_y, w-10-1650*s, 190*s))
	_patch(Rect2(3770, 2580, 750, 190), Rect2(w-5-750*s, footer_y, 750*s, 190*s))
	chrome.draw_line(Vector2(5, 6+102*s), Vector2(w-5, 6+102*s), Color("8799a5"))
	for offset in [7, 12, 17]:
		chrome.draw_line(Vector2(w-offset-3, h-6), Vector2(w-6, h-offset-3), Color("536b82"), 2)

func _input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if not event.pressed:
			if action.is_empty(): return
			action = ""
			_publish()
		else:
			var local: Vector2 = event.position - frame.position
			if not frame.get_rect().has_point(event.position): return
			if local.x > frame.size.x-26 and local.y > frame.size.y-26:
				action = "resize"
			elif local.y < 8+102*pixel_scale:
				action = "drag"
			else: return
			start_pointer = event.position
			start_rect = frame.get_rect()
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseMotion and not action.is_empty():
		var delta: Vector2 = event.position-start_pointer
		var available := get_viewport_rect().size-Vector2(0, 42)
		if action == "drag":
			frame.position = (start_rect.position+delta).clamp(Vector2.ZERO, (available-frame.size).max(Vector2.ZERO))
		else:
			var minimum := Vector2(1350*ART_SCALE+24, 250)
			frame.size = (start_rect.size+delta).clamp(minimum, available-frame.position)
		_layout()
		get_viewport().set_input_as_handled()

func _process(_delta: float) -> void:
	_publish()

func _publish() -> void:
	if not OS.has_feature("web"): return
	var cards := []
	for card in artwork.get_children():
		cards.append([card.position.x, card.position.y, card.size.x, card.size.y])
	var state := {"position": [frame.position.x, frame.position.y], "size": [frame.size.x, frame.size.y], "scroll": scroll.scroll_vertical, "scroll_max": scroll.get_v_scroll_bar().max_value-scroll.get_v_scroll_bar().page, "horizontal_scroll": scroll.scroll_horizontal, "bars_visible": [scroll.get_h_scroll_bar().visible, scroll.get_v_scroll_bar().visible], "cards": cards, "content_size": [artwork.size.x, artwork.size.y], "scale": pixel_scale, "action": action}
	JavaScriptBridge.eval("window.imageViewer="+JSON.stringify(state), true)
