/**
 * The BPMN 2.0 document behind the most recent render, kept so a host page can
 * offer it as a download.
 *
 * Mermaid's renderer contract returns nothing, so there is no way to hand the
 * document back through `draw`. It is stashed here instead and read through
 * `getLastBpmnXml`.
 *
 * Only the `auto` layout produces one: it serializes the diagram to BPMN and
 * gets the diagram interchange (shape bounds and edge waypoints) back from
 * bpmn-auto-layout. Under `elk` the geometry never takes BPMN form, so the
 * value is cleared and the getter returns undefined.
 */
let lastXml: string | undefined;

/** @internal Record — or, with no argument, clear — the current render's document. */
export function setLastBpmnXml(xml?: string): void {
  lastXml = xml;
}

/**
 * The layouted BPMN 2.0 XML for the diagram rendered last, or undefined when
 * that diagram was not laid out with `layout auto`.
 */
export function getLastBpmnXml(): string | undefined {
  return lastXml;
}
