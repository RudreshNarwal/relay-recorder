import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GET } from '../apps/web/app/api/openapi/route';

const document = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
function resolve(pointer: string): any {
  assert.ok(pointer.startsWith('#/'), `Non-local reference: ${pointer}`);
  return pointer.slice(2).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, key) => { assert.ok(value && key in value, `Unresolved reference: ${pointer}`); return value[key]; }, document);
}
function visit(value: unknown, callback: (value: Record<string, any>) => void) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(item => visit(item, callback)); return; }
  callback(value as Record<string, any>);
  Object.values(value).forEach(item => visit(item, callback));
}

test('OpenAPI references resolve and use JSON Schema nullability', () => {
  assert.match(document.openapi, /^3\.1\./);
  visit(document, value => {
    if (value.$ref) resolve(value.$ref);
    assert.ok(!('nullable' in value), 'OpenAPI 3.1 schemas must express nullability using JSON Schema');
  });
});

test('every operation has unique identity, valid security, and exact required path parameters', () => {
  const ids = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths) as [string, any][]) {
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    for (const [method, operation] of Object.entries(pathItem) as [string, any][]) {
      if (!['get', 'head', 'put', 'post', 'patch', 'delete', 'options'].includes(method)) continue;
      assert.ok(operation.operationId && !ids.has(operation.operationId), `${method} ${path}: missing/duplicate operationId`);
      ids.add(operation.operationId);
      const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])].map(parameter => parameter.$ref ? resolve(parameter.$ref) : parameter);
      const pathParameters = parameters.filter(parameter => parameter.in === 'path');
      assert.deepEqual(pathParameters.map(parameter => parameter.name).sort(), placeholders, `${method} ${path}: missing or extra path parameters`);
      assert.ok(pathParameters.every(parameter => parameter.required), `${method} ${path}: optional path parameter`);
      for (const requirement of operation.security ?? document.security) {
        for (const name of Object.keys(requirement)) assert.ok(document.components.securitySchemes[name], `Unknown security scheme ${name}`);
      }
      assert.ok(Object.keys(operation.responses).some(status => /^2\d\d$/.test(status)), `${method} ${path}: missing success response`);
    }
  }
});

test('public contract endpoint serves the single canonical JSON document', async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.match(response.headers.get('cache-control') || '', /public/);
  assert.deepEqual(await response.json(), document);
});
