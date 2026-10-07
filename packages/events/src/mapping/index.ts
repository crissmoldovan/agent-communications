export { compileMapping, MAPPING_LIMITS } from './compile.ts';
export { deliverySchema, deliverySchemaId } from './delivery-schema.ts';
export { checkMappedSize, evaluateMapping } from './evaluate.ts';
export { classifyMapped } from './provenance.ts';
export { applyRepresentation } from './represent.ts';
export type {
  CompiledMapping,
  MappedAddress,
  MappedClassification,
  MappedHandle,
  MappedUntrusted,
  MappedValue,
  MappingTemplate,
  MissingPolicy,
  Provenance,
  Representation,
} from './types.ts';
