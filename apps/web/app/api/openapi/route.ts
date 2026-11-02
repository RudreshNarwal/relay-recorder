import contract from '../../../../../docs/openapi.json';

export const dynamic = 'force-static';

export function GET() {
  return Response.json(contract, {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}
