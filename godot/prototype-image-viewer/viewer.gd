extends Control
# THROWAWAY: does a fixed screenshot canvas inside a resizable window feel right?
# Frame patching and drag clamping follow the existing atlas prototype.
const SOURCE := preload("res://reference.png")
var frame := Control.new()
var scroll := ScrollContainer.new()
var artwork := TextureRect.new()
var chrome := Control.new()
var hint := Label.new()
var pixel_scale := 0.2
var action := ""
var start_pointer := Vector2.ZERO
var start_rect := Rect2()

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(frame)
	scroll.follow_focus = true
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_SHOW_ALWAYS
	var background := StyleBoxFlat.new()
	background.bg_color = Color.WHITE
	scroll.add_theme_stylebox_override("panel", background)
	frame.add_child(scroll)
	var atlas := AtlasTexture.new()
	atlas.atlas = SOURCE
	atlas.region = Rect2(75, 240, 4530, 3900)
	artwork.texture = atlas
	artwork.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	artwork.mouse_filter = Control.MOUSE_FILTER_IGNORE
	scroll.add_child(artwork)
	chrome.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chrome.draw.connect(_draw_frame)
	frame.add_child(chrome)
	add_child(hint)
	hint.add_theme_font_size_override("font_size", 13)
	hint.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hint.text = "PROTOTYPE · Scroll artwork · Drag title bar · Resize bottom-right corner"
	get_viewport().size_changed.connect(_fit)
	_fit()

func _fit() -> void:
	var available := get_viewport_rect().size
	pixel_scale = minf(0.2, (available.x - 50) / 4679.0)
	frame.position = Vector2(16, 16)
	frame.size = Vector2(4679 * pixel_scale + 18, minf(650, available.y - 66))
	_layout()

func _layout() -> void:
	scroll.position = Vector2(75, 240) * pixel_scale
	scroll.size = frame.size - Vector2(150 * pixel_scale, 663 * pixel_scale)
	artwork.custom_minimum_size = Vector2(4530, 3900) * pixel_scale
	artwork.size = artwork.custom_minimum_size
	chrome.size = frame.size
	chrome.queue_redraw()
	hint.position = Vector2(16, get_viewport_rect().size.y - 30)
	_publish()

func _patch(source: Rect2, target: Rect2) -> void:
	if target.size.x > 0 and target.size.y > 0:
		chrome.draw_texture_rect_region(SOURCE, target, source)

func _draw_frame() -> void:
	var w := frame.size.x
	var h := frame.size.y
	var s := pixel_scale
	# Keep text, corners and buttons at the same scale; stretch blank bands only.
	_patch(Rect2(0, 0, 3100, 240), Rect2(0, 0, 3100*s, 240*s))
	_patch(Rect2(3100, 0, 800, 240), Rect2(3100*s, 0, w-3899*s, 240*s))
	_patch(Rect2(3880, 0, 799, 240), Rect2(w-799*s, 0, 799*s, 240*s))
	_patch(Rect2(0, 240, 75, 3900), Rect2(0, 240*s, 75*s, h-663*s))
	_patch(Rect2(4605, 240, 74, 3900), Rect2(w-74*s, 240*s, 74*s, h-663*s))
	_patch(Rect2(0, 4140, 1700, 423), Rect2(0, h-423*s, 1700*s, 423*s))
	_patch(Rect2(1700, 4140, 1500, 423), Rect2(1700*s, h-423*s, w-3179*s, 423*s))
	_patch(Rect2(3200, 4140, 1479, 423), Rect2(w-1479*s, h-423*s, 1479*s, 423*s))
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
			elif local.y < 240*pixel_scale:
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
			var minimum := Vector2(4000*pixel_scale, 1000*pixel_scale)
			frame.size = (start_rect.size+delta).clamp(minimum, available-frame.position)
		_layout()
		get_viewport().set_input_as_handled()

func _process(_delta: float) -> void:
	_publish()

func _publish() -> void:
	if not OS.has_feature("web"): return
	var state := {"position": [frame.position.x, frame.position.y], "size": [frame.size.x, frame.size.y], "scroll": scroll.scroll_vertical, "scroll_max": scroll.get_v_scroll_bar().max_value-scroll.get_v_scroll_bar().page, "content_size": [artwork.size.x, artwork.size.y], "scale": pixel_scale, "action": action}
	JavaScriptBridge.eval("window.imageViewer="+JSON.stringify(state), true)
