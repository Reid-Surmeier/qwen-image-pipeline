const strategyDirections = {
  "catalog-pair": "Show a dominant three-quarter hero view and one smaller matching side or closed view of the exact same manufactured model. Keep both complete, coherent and clearly related. Include only mechanically relevant accessories.",
  "technical-cutaway": "Show a dominant complete three-quarter hero view beside a clean partial cutaway or exploded mechanism view of the exact same product. The cutaway must visibly explain the invented function using believable mass-manufactured parts.",
  "deployed-system": "Show the complete product in a serious catalog deployment arrangement with its required tray, card, cable or control accessory, plus one smaller closed view. No people; the setup itself must explain operation.",
  "catalog-cutaway": "Show a dominant complete three-quarter hero view, a smaller matching alternate view and one restrained cutaway detail that makes the invented mechanism materially legible.",
};

export function productPrompt(packet, strategy) {
  if (!packet.validation.valid || !Object.hasOwn(strategyDirections, strategy)) throw new Error("Invalid packet or donor strategy");
    const prompt = [
      packet.productVisualBrief,
      "",
      "Presentation strategy:",
      strategyDirections[strategy],
      "Use one continuous neutral white late-1990s catalog studio sweep. Keep generous clean white space around every object. Do not crop the product. Do not render a page, border, caption, measurement, arrow, logo, brand mark or any readable text.",
    ].join("\n");
  return prompt;
}
