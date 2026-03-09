// Deno globals and URL imports for Supabase Edge Functions (not used by app tsconfig).
declare const Deno: {
  env: { get(key: string): string | undefined };
};
declare module 'https://deno.land/std@0.177.0/http/server.ts' {
  export function serve(
    handler: (req: Request) => Promise<Response> | Response
  ): void;
}

declare module 'https://esm.sh/@supabase/supabase-js@2' {
  export function createClient(
    supabaseUrl: string,
    supabaseKey: string,
    options?: Record<string, unknown>
  ): {
    from: (table: string) => { select: (cols?: string) => any; eq: (col: string, val: unknown) => any };
    auth: unknown;
    rpc: (fn: string, params: object) => Promise<{ data: unknown; error: unknown }>;
  };
}
