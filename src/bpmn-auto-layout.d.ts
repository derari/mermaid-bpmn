declare module 'bpmn-auto-layout' {
  /**
   * Lays out a BPMN 2.0 diagram and returns the XML with a generated
   * BPMNDiagram section.
   *
   * v1 resolves to the XML string itself; later versions resolve to an object
   * carrying the XML alongside any warnings, so both shapes are declared.
   */
  export function layoutProcess(
    xml: string,
  ): Promise<string | { xml: string; warnings?: unknown[] }>;
}
