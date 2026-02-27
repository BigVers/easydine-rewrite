// Deno globals and URL imports for Supabase Edge Functions (not used by app tsconfig).
declare const Deno: {
  env: { get(key: string): string | undefined };
};
declare module 'https://deno.land/std@0.177.0/http/server.ts' {
  export function serve(
    handler: (req: Request) => Promise<Response> | Response
  ): void;
}
