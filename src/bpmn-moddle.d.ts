/**
 * Minimal typings for `bpmn-moddle`.
 *
 * The package ships generated types, but only under its `./types` export path —
 * the main entry point has none, and they describe the BPMN element shapes
 * rather than the reader/writer API. Only the handful of members used here is
 * declared.
 */
declare module 'bpmn-moddle' {
  /** An element of the BPMN meta model. Its properties are dynamic by nature. */
  export interface ModdleElement {
    $type: string;
    id?: string;
    [property: string]: unknown;
  }

  export interface ParseResult {
    rootElement: ModdleElement;
    elementsById: Record<string, ModdleElement>;
    references: unknown[];
    warnings: unknown[];
  }

  export interface SerializeOptions {
    format?: boolean;
    preamble?: boolean;
  }

  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>, options?: Record<string, unknown>);
    create<T extends object>(type: string, attributes?: T): ModdleElement & T;
    fromXML(xml: string, typeName?: string): Promise<ParseResult>;
    toXML(element: ModdleElement, options?: SerializeOptions): Promise<{ xml: string }>;
  }

  export default BpmnModdle;
}
