import { BpmnModdle } from 'bpmn-moddle';

/**
 * The shared BPMN meta model.
 *
 * Building a `BpmnModdle` parses the BPMN, DI, DC and BPMNDI schemas, and the
 * result is stateless, so one instance is reused for reading and writing.
 * It is created lazily so importing this module stays cheap for diagrams that
 * never use the auto layout.
 */
let instance: BpmnModdle | undefined;

export function moddle(): BpmnModdle {
  instance ??= new BpmnModdle();
  return instance;
}
