import { cn } from '@/lib/utils'

/** Loading placeholder with a stable shape so layout does not jump. */
export function Skeleton({ className }: { className?: string }) {
  return <div role="presentation" className={cn('skeleton', className)} />
}

/** Card-shaped skeleton used by list and dashboard views. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="panel p-5">
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="mt-3 h-5 w-3/5" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: lines }).map((_, index) => (
          <Skeleton key={index} className={index === lines - 1 ? 'h-3 w-2/5' : 'h-3 w-full'} />
        ))}
      </div>
    </div>
  )
}

export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-4 border-b border-hairline px-5 py-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="ml-auto h-3 w-20" />
        <Skeleton className="h-3 w-16" />
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 border-b border-hairline/60 px-5 py-4 last:border-0">
          <Skeleton className="size-8 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      ))}
    </div>
  )
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="panel p-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-4 h-8 w-16" />
          <Skeleton className="mt-3 h-2.5 w-28" />
        </div>
      ))}
    </div>
  )
}
