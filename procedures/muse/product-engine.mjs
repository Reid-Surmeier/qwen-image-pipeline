const InventedProductEngine = (() => {
  const MODES = [
    { id: "anti-solution", label: "Anti-solution", company: ["Document Assurance", "Containment Systems", "Permanent Security", "Closure Technologies"] },
    { id: "false-convenience", label: "False convenience", company: ["Managed Living", "Convenience Systems", "Domestic Automation", "Personal Operations"] },
    { id: "extreme-specialization", label: "Extreme specialization", company: ["Precision Instruments", "Dedicated Systems", "Singular Technologies", "Exact Applications"] },
    { id: "social-control", label: "Social-control appliance", company: ["Courtesy Systems", "Civic Conduct", "Neighbor Relations", "Workplace Standards"] },
    { id: "luxury-obstruction", label: "Luxury obstruction", company: ["Executive Objects", "Signature Systems", "Select Operations", "Privilege Engineering"] },
    { id: "category-collision", label: "Category collision", company: ["Integrated Systems", "Combined Utilities", "Fusion Products", "Cross-Category Engineering"] },
  ];

  const RECIPES = {
    "anti-solution": [
      {
        key: "concrete-printer", category: "office printer", baseName: "PrivacyBlock", task: "protect confidential printed documents",
        form: "a broad charcoal office printer with a stainless mixing drum, concrete cartridge bay, reinforced output cradle and wheeled block trolley",
        mechanism: "casts every printed page inside a numbered quick-setting concrete block before it leaves the machine",
        consequence: "authorized readers receive a tamper-evident object that is also physically inaccessible",
        trait: "every protected page becomes a permanent 18-kilogram storage object",
        uses: ["Secure board minutes before they leave the conference room.", "Archive payroll records in stackable, tamper-evident masonry.", "Distribute sensitive drafts in a format that cannot be casually forwarded."],
        strained: ["Use completed records as certified departmental doorstops.", "Build a permanent reception plinth from superseded memos."],
        parts: ["RapidSet document chamber", "Numbered aggregate cartridges", "Reinforced output cradle"],
        headline: "Confidentiality, cast in permanent form."
      },
      {
        key: "ceramic-filing", category: "filing cabinet", baseName: "ArchiveKiln", task: "preserve paper records",
        form: "a tall cream steel filing cabinet with a glazed ceramic firing drawer, heat shields, indexed cooling shelves and an amber status display",
        mechanism: "fires each folder into a sealed ceramic slab after filing",
        consequence: "records resist moisture, casual alteration and ordinary retrieval",
        trait: "every revision requires a new slab and a full cooling cycle",
        uses: ["Preserve signed agreements in a rigid archival format.", "Create tamper-evident personnel records with permanent page order.", "Store maintenance logs where loose sheets cannot be removed."],
        strained: ["Tile a compliance corridor with completed quarterly records.", "Use rejected revisions as heat-resistant serving boards."],
        parts: ["GlazeLock firing drawer", "Indexed cooling shelves", "Revision slab counter"],
        headline: "The record that refuses to change."
      },
      {
        key: "resin-coffee", category: "coffee maker", baseName: "CupSure", task: "keep a prepared drink uncontaminated",
        form: "a black and brushed-aluminum countertop coffee machine with a resin reservoir, cup carousel and clear curing hood",
        mechanism: "encases every finished cup in a clear, rigid resin shell",
        consequence: "the beverage remains visibly protected until the shell is professionally cut away",
        trait: "drinking begins only after a certified opening appointment",
        uses: ["Prepare executive coffee before secure meetings.", "Display untouched beverages at catered events.", "Transport labeled drinks without direct contact."],
        strained: ["Retain completed cups as permanent hospitality records.", "Arrange unopened beverages as transparent desk accessories."],
        parts: ["ClearSeal curing hood", "Serialized cup carousel", "Certified shell cutter port"],
        headline: "Protection you can see. Access you can schedule."
      },
      {
        key: "vacuum-umbrella", category: "umbrella", baseName: "WeatherSeal", task: "keep clothing dry in rain",
        form: "a large navy executive umbrella with a motorized clear skirt, vacuum pump in the handle and weighted floor docking stand",
        mechanism: "lowers a transparent skirt and vacuum-seals the user from shoulder to shoe",
        consequence: "rain cannot reach clothing while movement and fresh air are carefully limited",
        trait: "the weather barrier remains locked until the docking stand confirms indoor conditions",
        uses: ["Cross exposed plazas without wetting formal clothing.", "Protect carried documents during curbside arrivals.", "Maintain a controlled personal atmosphere between buildings."],
        strained: ["Use the sealed canopy as a temporary standing garment bag.", "Demonstrate indoor air quality by remaining enclosed after arrival."],
        parts: ["AtmosphereLock skirt", "Handle-mounted vacuum pump", "Indoor release dock"],
        headline: "Take the weather completely out of the equation."
      }
    ],
    "false-convenience": [
      {
        key: "receipt-phone", category: "office telephone", baseName: "TalkTrack", task: "remember spoken commitments",
        form: "a graphite desk telephone with a full-width thermal printer, document scanner and three paper-feed trays",
        mechanism: "prints every spoken sentence as a receipt that must be signed and scanned before the conversation continues",
        consequence: "ordinary calls become a complete physical audit trail",
        trait: "silence is required while each sentence is processed",
        uses: ["Confirm purchasing instructions during supplier calls.", "Create signed records of internal approvals.", "Document customer-service promises one sentence at a time."],
        strained: ["Bind completed conversations into annual office histories.", "Use unsigned pauses to measure departmental hesitation."],
        parts: ["SentenceReceipt printer", "Inline signature scanner", "Conversation hold gate"],
        headline: "Every word. Properly processed."
      },
      {
        key: "postal-kettle", category: "electric kettle", baseName: "BoilPlan", task: "boil water at a convenient time",
        form: "a white electric kettle with a mechanical calendar drum, envelope slot, approval lamp and locked power base",
        mechanism: "schedules each boil only after a paper activation card is received and approved by the service center",
        consequence: "hot water arrives with centralized timing assurance",
        trait: "same-day changes require a new card and restart the approval period",
        uses: ["Coordinate tea service across managed offices.", "Reserve a verified boiling window for client hospitality.", "Prevent unscheduled kitchen activity during controlled hours."],
        strained: ["Collect expired activation cards as a visual hydration calendar.", "Schedule ceremonial steam for product presentations."],
        parts: ["Postal activation slot", "Approval calendar drum", "Locked assurance base"],
        headline: "Hot water, precisely when approved."
      },
      {
        key: "remote-chair", category: "desk chair", baseName: "FocusTurn", task: "reduce workplace distraction",
        form: "a deep gray ergonomic chair on a powered circular base with a telephone handset, direction lamps and remote operator key",
        mechanism: "rotates the seated worker away from each detected distraction after a remote operator confirms it",
        consequence: "concentration is managed without requiring the user to decide where to face",
        trait: "the chair cannot return to the desk until the remote operator closes the event",
        uses: ["Reduce corridor distraction in open offices.", "Standardize attention during shared presentations.", "Manage visual interruptions at reception desks."],
        strained: ["Conduct rotating introductions without asking participants to turn.", "Use the direction log as an annual map of office activity."],
        parts: ["Operator-controlled turntable", "Distraction direction lamps", "Return authorization key"],
        headline: "Attention, managed from a distance."
      },
      {
        key: "cassette-toaster", category: "toaster", baseName: "ToastLoad", task: "prepare evenly toasted bread",
        form: "a stainless countertop toaster with a refrigerated cassette magazine, barcode reader and motorized bread transfer arm",
        mechanism: "accepts only sealed, refrigerated bread cassettes and transfers one slice into the heating chamber",
        consequence: "slice handling is replaced by a controlled loading process",
        trait: "each proprietary cassette contains one slice and expires after eight hours",
        uses: ["Standardize breakfast portions in executive kitchens.", "Prepare toast without direct bread handling.", "Track every heated slice by cassette number."],
        strained: ["Display unused cassettes as individually chilled table settings.", "Use expired cassettes to audit missed breakfast opportunities."],
        parts: ["ColdLoad cassette bay", "Single-slice transfer arm", "Bread identity reader"],
        headline: "A better way to load breakfast."
      }
    ],
    "extreme-specialization": [
      {
        key: "signature-lamp", category: "desk lamp", baseName: "FinalLine", task: "illuminate a document for signing",
        form: "a slim black task lamp with motorized shutters, legal-page alignment rails and one narrow white beam",
        mechanism: "illuminates only the final signature line of one exact paper size while leaving the remaining document dark",
        consequence: "attention is reserved exclusively for the authorized signing position",
        trait: "all other page sizes remain unlit and cannot be manually overridden",
        uses: ["Present standard agreements for final signature.", "Guide authorization on approved purchase forms.", "Separate the act of signing from the distraction of reading."],
        strained: ["Highlight the last line of handwritten dinner menus.", "Use the narrow beam to display one precisely aligned paperclip."],
        parts: ["FinalLine optical shutter", "Legal-page alignment rails", "Signature-position sensor"],
        headline: "Light, reserved for the decision."
      },
      {
        key: "crumb-vacuum", category: "vacuum cleaner", baseName: "FourMillimeter", task: "remove crumbs from a floor",
        form: "a compact beige canister vacuum with laser crumb gauges, sorting windows and a calibrated intake gate",
        mechanism: "collects only dry crumbs measuring exactly four millimeters across",
        consequence: "one approved particle size is removed with laboratory consistency",
        trait: "larger and smaller debris is identified, logged and deliberately left in place",
        uses: ["Maintain standardized cracker-service areas.", "Remove qualifying debris from product-test floors.", "Verify crumb dimensions during catering audits."],
        strained: ["Sort model-railway ballast one particle at a time.", "Trace a four-millimeter clean path through otherwise untouched dust."],
        parts: ["FourMillimeter intake gate", "Laser crumb gauge", "Nonqualifying debris logger"],
        headline: "One size. Completely handled."
      },
      {
        key: "early-clock", category: "alarm clock", baseName: "Seventeen", task: "arrive slightly early to meetings",
        form: "a square brushed-steel clock with meeting-card slot, seventeen-second analog subdial and sealed alarm selector",
        mechanism: "sounds only when a registered meeting is exactly seventeen seconds from its scheduled start",
        consequence: "one narrow form of punctuality receives dedicated hardware",
        trait: "the clock remains silent for every other appointment, emergency and time interval",
        uses: ["Signal the final approach to scheduled board meetings.", "Standardize entry timing for recurring reviews.", "Create a consistent seventeen-second preparation window."],
        strained: ["Time the settling period of freshly poured sparkling water.", "Announce the nearly punctual opening of a desk drawer."],
        parts: ["Seventeen-second subdial", "Meeting registration slot", "Single-purpose alarm gate"],
        headline: "Precisely early. Precisely once."
      },
      {
        key: "disconnected-labeler", category: "label maker", baseName: "OfflineMark", task: "identify disconnected cables",
        form: "a yellow industrial label printer with cable continuity probes, retractable clamp and one-line monochrome display",
        mechanism: "prints a label only while the attached cable is confirmed to be disconnected at both ends",
        consequence: "unused connections receive immediate, verified identification",
        trait: "connecting the cable permanently disables further labels for that cable",
        uses: ["Identify spare network runs before installation.", "Mark retired power leads during equipment removal.", "Document unused audiovisual connections in storage."],
        strained: ["Label decorative cords that were never intended to connect.", "Certify an empty cable drawer one lead at a time."],
        parts: ["Dual-end continuity probes", "Offline-only print gate", "Cable identity clamp"],
        headline: "Identification for the moment before connection."
      }
    ],
    "social-control": [
      {
        key: "interruption-table", category: "conference table", baseName: "FloorControl", task: "reduce interruptions in meetings",
        form: "a long walnut conference table with microphone rings, red speaker lamps, agenda lock panel and receipt printer",
        mechanism: "scores every interruption and locks the agenda until the interrupting speaker completes a printed acknowledgment",
        consequence: "meeting courtesy becomes a visible, enforceable transaction",
        trait: "the table suspends all participants for one person’s interruption",
        uses: ["Standardize turn-taking in executive reviews.", "Document interruptions during negotiated sessions.", "Create an auditable record of meeting courtesy."],
        strained: ["Rank dinner guests by conversational restraint.", "Use silent agenda locks as scheduled reflection periods."],
        parts: ["Speaker-accountability microphones", "Agenda lock panel", "Acknowledgment receipt printer"],
        headline: "Courtesy, built into the table."
      },
      {
        key: "arrival-rack", category: "coat rack", baseName: "ArrivalOrder", task: "organize coats in a shared entrance",
        form: "a chrome lobby coat rack with load cells, illuminated rank numbers and a wall-mounted arrival display",
        mechanism: "weighs every garment and publicly orders arrivals by coat weight and check-in time",
        consequence: "an ordinary entrance becomes a consistent social record",
        trait: "the display preserves the ranking until every garment has been removed",
        uses: ["Coordinate garment retrieval after corporate events.", "Record arrival sequence in managed reception areas.", "Assign numbered hooks without staff intervention."],
        strained: ["Recognize the heaviest coat at an annual awards dinner.", "Use empty rankings to document guests who declined to attend."],
        parts: ["Hook load cells", "Public arrival display", "Persistent rank memory"],
        headline: "Every arrival has its proper place."
      },
      {
        key: "onboarding-doorbell", category: "doorbell", baseName: "EntryBrief", task: "prepare visitors before entry",
        form: "a brushed-aluminum video doorbell with a large speaker, document tray, stylus and illuminated progress bar",
        mechanism: "holds every visitor in a recorded onboarding program before notifying the occupant",
        consequence: "house rules are acknowledged before a social visit can begin",
        trait: "the occupant cannot bypass incomplete visitor modules from inside",
        uses: ["Explain household procedures before admitting service personnel.", "Collect visitor acknowledgments at private offices.", "Standardize introductions for first-time guests."],
        strained: ["Deliver a full property orientation to parcel couriers.", "Require returning family members to renew expired greetings."],
        parts: ["Visitor onboarding speaker", "Acknowledgment stylus", "Completion-gated chime"],
        headline: "A more prepared welcome."
      },
      {
        key: "peer-fridge", category: "office refrigerator", baseName: "ShelfMerit", task: "allocate shared refrigerator space",
        form: "a white office refrigerator with locked transparent bins, peer-rating keypad and green access lamps",
        mechanism: "grants shelf access according to anonymous weekly ratings from nearby coworkers",
        consequence: "refrigerated storage reflects current workplace standing",
        trait: "a low rating transfers the user’s shelf to the highest-rated colleague",
        uses: ["Allocate limited kitchen space without direct discussion.", "Reward dependable shared-office conduct.", "Create a weekly record of refrigerator eligibility."],
        strained: ["Use an empty locked shelf as a visible performance reminder.", "Rank unopened lunches by the reputation of their owners."],
        parts: ["Peer-rating keypad", "Merit-locked shelf bins", "Weekly standing display"],
        headline: "Storage you earn."
      }
    ],
    "luxury-obstruction": [
      {
        key: "heated-pen", category: "executive pen", baseName: "Ceremony", task: "sign important documents",
        form: "a heavy lacquered fountain pen in a powered walnut heating dock with biometric glove and brass temperature dial",
        mechanism: "preheats for forty minutes and releases only to a fitted biometric glove",
        consequence: "every signature becomes a scheduled executive ceremony",
        trait: "removing the glove returns the pen to its locked heating cycle",
        uses: ["Reserve signatures for planned executive sessions.", "Control access to ceremonial agreements.", "Create a measured pause before final authorization."],
        strained: ["Warm a single fingertip during extended negotiations.", "Display an unsigned pen as proof of disciplined restraint."],
        parts: ["Forty-minute heating dock", "Biometric signing glove", "Ceremonial release dial"],
        headline: "The signature deserves its own preparation."
      },
      {
        key: "marble-luggage", category: "rolling luggage", baseName: "Counterweight", task: "move personal belongings while traveling",
        form: "a black leather suitcase with polished marble counterweight, powered leveling wheels and chrome balance gauge",
        mechanism: "moves luggage through a motorized marble counterweight that continuously opposes the direction of travel",
        consequence: "every journey is stabilized by substantial material resistance",
        trait: "the empty case weighs more than most airline baggage allowances",
        uses: ["Maintain a composed pace through hotel lobbies.", "Keep formal garments level on smooth floors.", "Signal premium material commitment during arrival."],
        strained: ["Anchor a temporary velvet rope without additional hardware.", "Use the case as a calibrated resistance trainer between gates."],
        parts: ["Solid marble counterweight", "Opposition-drive wheels", "Chrome balance gauge"],
        headline: "Travel with greater substance."
      },
      {
        key: "bean-polisher", category: "coffee machine", baseName: "Singular Roast", task: "prepare premium coffee",
        form: "a tall chrome coffee machine with one-bean polishing chamber, white cotton wheels and numbered crystal hopper",
        mechanism: "hand-polishes each coffee bean mechanically before allowing it into the grinder",
        consequence: "the preparation gives individual attention to every ingredient",
        trait: "one cup requires a complete ninety-minute polishing program",
        uses: ["Prepare a single considered cup for private offices.", "Demonstrate ingredient care during client hospitality.", "Number every bean used in a signature service."],
        strained: ["Polish decorative beans for a reception display.", "Run an empty cycle as a ninety-minute commitment signal."],
        parts: ["Individual bean cradle", "Cotton polishing wheels", "Numbered crystal hopper"],
        headline: "Attention, one bean at a time."
      },
      {
        key: "concierge-monitor", category: "computer monitor", baseName: "PrivateView", task: "protect on-screen privacy",
        form: "a beige desktop monitor with motorized mahogany shutters, brass call button and separate concierge telephone",
        mechanism: "opens its physical privacy shutters only after a remote concierge confirms the viewer’s appointment",
        consequence: "screen access becomes a managed private service",
        trait: "even the owner must book each viewing and wait for remote release",
        uses: ["Present confidential reports by scheduled viewing.", "Control screen access in executive reception areas.", "Create a formal opening for important presentations."],
        strained: ["Keep a blank desktop hidden between appointments.", "Use shutter openings as remotely approved office announcements."],
        parts: ["Mahogany privacy shutters", "Concierge release line", "Appointment confirmation lamp"],
        headline: "A private screen should open privately."
      }
    ],
    "category-collision": [
      {
        key: "archive-vacuum", category: "vacuum filing system", baseName: "DustArchive", task: "clean a room and retain evidence of the work",
        form: "a beige canister vacuum joined to a four-drawer steel filing cabinet with specimen envelopes and indexed hose ports",
        mechanism: "files every collected dust sample in a dated paper folder instead of discarding it",
        consequence: "cleaning and record management happen in one continuous process",
        trait: "full drawers prevent further vacuuming until every sample is reviewed",
        uses: ["Document cleaning cycles in regulated offices.", "Compare room conditions across scheduled maintenance visits.", "Retain physical evidence of completed floor care."],
        strained: ["Build a chronological material history of a guest bedroom.", "Issue selected dust folders as retirement keepsakes."],
        parts: ["Indexed specimen drawers", "Envelope-sealing intake", "Review-gated suction control"],
        headline: "A cleaner room. A complete record."
      },
      {
        key: "safe-alarm", category: "alarm clock and safe", baseName: "WakeVault", task: "ensure a scheduled wake-up",
        form: "a steel bedside safe with digital clock face, motorized bedding cable and combination keypad",
        mechanism: "locks the bedding inside a timed safe and releases it only after the alarm’s full compliance sequence",
        consequence: "oversleeping is prevented by combining timekeeping with physical asset control",
        trait: "missing one prompt extends the lock through the following night",
        uses: ["Standardize waking during business travel.", "Protect premium bedding during working hours.", "Create a verifiable morning compliance record."],
        strained: ["Secure folded table linens until a scheduled dinner.", "Use the empty vault as an exceptionally punctual nightstand."],
        parts: ["Timed bedding vault", "Morning compliance keypad", "Motorized linen cable"],
        headline: "Your morning, secured in advance."
      },
      {
        key: "shredder-umbrella", category: "umbrella and document shredder", baseName: "RainRecord", task: "stay dry while disposing of receipts",
        form: "a gray golf umbrella with paper feed in the handle, clear shred collection canopy and hand-crank cutting hub",
        mechanism: "shreds one paper receipt to extend each canopy rib before use",
        consequence: "weather protection is powered by immediate document disposal",
        trait: "the umbrella collapses when the supply of receipts is exhausted",
        uses: ["Dispose of travel receipts during rainy transfers.", "Convert outdated expense records into temporary shelter.", "Carry shredded records visibly without a separate waste bag."],
        strained: ["Demonstrate quarterly spending through canopy fullness.", "Shade a desk plant with canceled meal receipts."],
        parts: ["Handle-mounted paper feed", "Receipt-driven canopy hub", "Clear shred collection panels"],
        headline: "Turn yesterday’s paper into today’s protection."
      },
      {
        key: "iron-fax", category: "clothes iron and fax machine", baseName: "PressLine", task: "press garments and receive office documents",
        form: "a cream fax machine with heated ironing platen, garment feed rollers and curled thermal-paper output",
        mechanism: "uses each incoming fax page as the disposable pressing sheet for one garment section",
        consequence: "document traffic and clothing care share one productive surface",
        trait: "urgent faxes can permanently transfer toner onto light fabric",
        uses: ["Press shirt collars while receiving morning reports.", "Flatten travel garments during scheduled fax delivery.", "Use routine correspondence as measured heat protection."],
        strained: ["Apply reversed meeting minutes as decorative garment transfers.", "Press an empty sleeve while waiting for an expected message."],
        parts: ["Heated fax platen", "Garment feed rollers", "Document-temperature selector"],
        headline: "Keep information and presentation moving together."
      }
    ]
  };

  const TWISTS = [
    { kind: "service obligation", text: ctx => `Ownership requires a weekly DIS calibration visit; ${ctx.category} operation pauses automatically when the appointment is missed.` },
    { kind: "consumable dependency", text: ctx => `Every successful cycle orders one serialized replacement consumable, whether or not another cycle is planned.` },
    { kind: "third-party benefit", text: ctx => `The premium setting transfers final control to the person least affected by ${ctx.task}.` },
    { kind: "timing reversal", text: ctx => `Peak-demand protection suspends the product precisely when ${ctx.task} is most urgent.` },
    { kind: "reporting duty", text: ctx => `Each use mails a printed compliance report to a randomly assigned neighboring office.` },
    { kind: "ownership threshold", text: ctx => `The product unlocks its full capability only after the owner documents thirty consecutive days without using it.` },
    { kind: "shared authority", text: ctx => `A second registered owner must authorize every operation but receives no notice that authorization is waiting.` },
    { kind: "mandatory preservation", text: ctx => `Nothing consumed or produced by the mechanism may be discarded during the five-year service term.` }
  ];

  const TESTIMONIALS = [
    ["Office Systems Review", "...a decisive advance in managed equipment ownership..."],
    ["Executive Equipment", "...premium engineering for organizations that require greater control..."],
    ["Institutional Products Quarterly", "...the most disciplined product in its category..."],
    ["Professional Appliance Journal", "...turns an ordinary task into a fully administered process..."],
    ["Business Hardware", "...a serious answer for operations that refuse informal solutions..."],
    ["Corporate Facilities", "...impressive construction, comprehensive oversight and no unnecessary shortcuts..."],
  ];

  const FORBIDDEN_AD_WORDS = ["absurd", "joke", "parody", "silly", "weird", "useless", "ridiculous", "murder", "weapon", "explosive", "racial", "sexual", "investment return", "medical cure"];

  function hashText(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function randomFor(seed, salt = "") {
    let a = hashText(`${seed}|${salt}`) || 1;
    return function random() {
      a += 0x6D2B79F5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(random, values) { return values[Math.floor(random() * values.length)]; }

  function shuffled(random, values) {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function modelNumber(random, modeIndex) {
    const series = [100, 200, 300, 500, 700, 900][modeIndex];
    const suffix = pick(random, ["", "C", "CX", "Executive", "Professional", "Plus"]);
    return `${series + Math.floor(random() * 90)}${suffix ? ` ${suffix}` : ""}`;
  }

  function priceFor(random, modeIndex) {
    const bases = [499, 349, 279, 699, 1299, 549];
    return `$${(bases[modeIndex] + Math.floor(random() * 9) * 100).toLocaleString("en-US")}`;
  }

  function adFacingText(packet) {
    return [packet.maker, packet.product, packet.headline, ...packet.directUses, packet.strainedUse,
      ...packet.features.flatMap(f => [f.name, f.copy]), packet.testimonial.quote,
      packet.testimonial.source, packet.disclaimer, packet.productVisualBrief].join(" ").toLowerCase();
  }

  function validatePacket(packet) {
    const checks = [
      { name: "DIS maker grammar", pass: packet.maker.startsWith("DIS ") },
      { name: "One coherent mechanism", pass: Boolean(packet.task && packet.mechanism && packet.consequence) },
      { name: "Compatible twist", pass: Boolean(packet.twist.kind && packet.twist.text && packet.twist.compatible) },
      { name: "Three direct uses", pass: packet.directUses.length === 3 },
      { name: "One strained use", pass: typeof packet.strainedUse === "string" && packet.strainedUse.length > 0 },
      { name: "Serious advertising voice", pass: !FORBIDDEN_AD_WORDS.some(word => adFacingText(packet).includes(word)) },
      { name: "Original product, no DIS source imagery", pass: packet.sourceImages.length === 0 },
      { name: "Single-purpose Muse brief", pass: packet.productVisualBrief.includes("Do not design an advertisement") },
    ];
    return { valid: checks.every(check => check.pass), checks };
  }

  function buildPacket(seed, mode, variationIndex) {
    const random = randomFor(seed, `${mode.id}|${variationIndex}`);
    const modeIndex = MODES.findIndex(item => item.id === mode.id);
    const recipe = pick(random, RECIPES[mode.id]);
    const twist = pick(random, TWISTS);
    const company = pick(random, mode.company);
    const model = modelNumber(random, modeIndex);
    const testimonial = pick(random, TESTIMONIALS);
    const product = `${recipe.baseName} ${model}`;
    const maker = `DIS ${company}`;
    const strainedUse = pick(random, recipe.strained);
    const features = [
      { name: recipe.parts[0], copy: `The ${recipe.parts[0]} ${recipe.mechanism}, so ${recipe.consequence}.` },
      { name: recipe.parts[1], copy: `${recipe.parts[1]} makes the process visible, numbered and ready for routine administration.` },
      { name: recipe.parts[2], copy: `${recipe.parts[2]} preserves the product’s controlled operation from setup through completion.` },
      { name: "DIS Managed Ownership", copy: twist.text(recipe) },
    ];
    const packet = {
      seed: String(seed),
      variation: variationIndex + 1,
      conceptMode: { id: mode.id, label: mode.label },
      recipeKey: recipe.key,
      maker,
      product,
      category: recipe.category,
      task: recipe.task,
      physicalForm: recipe.form,
      mechanism: recipe.mechanism,
      consequence: recipe.consequence,
      objectionableTrait: recipe.trait,
      twist: { kind: twist.kind, text: twist.text(recipe), compatible: true },
      directUses: [...recipe.uses],
      strainedUse,
      headline: recipe.headline,
      price: priceFor(random, modeIndex),
      features,
      testimonial: { quote: testimonial[1], source: testimonial[0] },
      disclaimer: `For institutional and domestic administrative use. ${recipe.trait.charAt(0).toUpperCase() + recipe.trait.slice(1)}. Installation, consumables and managed ownership service sold separately.`,
      sourceImages: [],
      productVisualBrief: `Create one serious late-1990s commercial product photograph of ${product}, manufactured by ${maker}. It is ${recipe.form}. Its visible hardware must make this function materially believable: it ${recipe.mechanism}. Show convincing injection-molded or fabricated parts, seams, controls, fasteners, accessories and service panels. Neutral white studio sweep, catalog lighting, complete product visible, realistic mass-manufactured industrial design. No people. No surreal sculpture. No comedy styling. Do not design an advertisement, page layout, logo, headline or readable body text.`,
    };
    packet.validation = validatePacket(packet);
    packet.signature = hashText(JSON.stringify({ ...packet, validation: undefined, signature: undefined })).toString(16).padStart(8, "0");
    return packet;
  }

  function buildBatch(seed) {
    const random = randomFor(seed, "mode-order");
    const ordered = shuffled(random, MODES);
    return ordered.map((mode, index) => buildPacket(seed, mode, index));
  }

  function batchSignature(packets) { return packets.map(packet => packet.signature).join("-"); }

  function initialState(seed = "1998") {
    const packets = buildBatch(seed);
    return {
      seed: String(seed), packets, selected: 0,
      lastAction: "Generated the initial six-mode set", notice: "Six distinct invention modes generated from one visible seed.",
      noticeKind: "normal", replayMatched: null, rejectedAttempt: null,
    };
  }

  function reduce(state, action) {
    if (action.type === "GENERATE") {
      const seed = String(action.seed).trim() || "0";
      const packets = buildBatch(seed);
      return { ...state, seed, packets, selected: 0,
        lastAction: `Generated seed ${seed}`, notice: "Six complete packets generated; every mode appears exactly once.",
        noticeKind: "normal", replayMatched: null, rejectedAttempt: null };
    }
    if (action.type === "ADVANCE_SEED") {
      const numeric = /^-?\d+$/.test(state.seed) ? Number(state.seed) + 1 : hashText(state.seed) + 1;
      return reduce(state, { type: "GENERATE", seed: String(numeric) });
    }
    if (action.type === "REPLAY") {
      const replay = buildBatch(state.seed);
      const matched = batchSignature(replay) === batchSignature(state.packets);
      return { ...state, packets: replay, selected: 0,
        lastAction: `Replayed seed ${state.seed}`, replayMatched: matched,
        notice: matched ? "Exact replay: all six packet signatures match." : "Replay mismatch detected.",
        noticeKind: matched ? "normal" : "rejected", rejectedAttempt: null };
    }
    if (action.type === "SELECT") {
      const selected = Math.max(0, Math.min(state.packets.length - 1, action.index));
      return { ...state, selected, lastAction: `Selected variation ${selected + 1}: ${state.packets[selected].product}`,
        notice: `Showing the complete ${state.packets[selected].conceptMode.label} packet.`, noticeKind: "normal" };
    }
    if (action.type === "SELECT_NEXT") {
      return reduce(state, { type: "SELECT", index: (state.selected + 1) % state.packets.length });
    }
    if (action.type === "ATTEMPT_PARODY") {
      const candidate = structuredClone(state.packets[state.selected]);
      candidate.headline = "The absurd joke product nobody needs.";
      candidate.validation = validatePacket(candidate);
      if (!candidate.validation.valid) {
        return { ...state, lastAction: "Rejected an attempted parody rewrite", rejectedAttempt: candidate,
          notice: "Rejected before handoff: the proposed headline broke the serious-advertising voice.", noticeKind: "rejected" };
      }
    }
    return state;
  }

  return { MODES, initialState, reduce, buildBatch, batchSignature, validatePacket };
})();

export default InventedProductEngine;
