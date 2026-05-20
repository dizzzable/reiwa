import { memo } from 'react'

interface NetworkBgProps {
  className?: string
  intensity?: 'low' | 'medium' | 'high'
}

export const NetworkBg = memo(function NetworkBg({ className = '', intensity = 'medium' }: NetworkBgProps) {
  const opacity = intensity === 'low' ? 0.3 : intensity === 'high' ? 0.7 : 0.5

  return (
    <div className={`pointer-events-none fixed inset-0 overflow-hidden ${className}`} aria-hidden>
      {/* Ambient glow blobs */}
      <div
        className="absolute -top-32 -left-32 h-96 w-96 rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(244,63,94,0.15) 0%, transparent 70%)',
          opacity,
          filter: 'blur(40px)',
        }}
      />
      <div
        className="absolute top-1/3 -right-24 h-80 w-80 rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(244,63,94,0.10) 0%, transparent 70%)',
          opacity,
          filter: 'blur(60px)',
        }}
      />
      <div
        className="absolute bottom-24 left-1/4 h-64 w-64 rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(139,92,246,0.08) 0%, transparent 70%)',
          opacity,
          filter: 'blur(50px)',
        }}
      />

      {/* SVG triangulated network */}
      <svg
        className="absolute inset-0 h-full w-full"
        style={{ opacity: opacity * 0.4 }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern id="net-grid" x="0" y="0" width="80" height="80" patternUnits="userSpaceOnUse">
            <circle cx="40" cy="40" r="1" fill="rgba(244,63,94,0.6)" />
          </pattern>
          <filter id="net-blur">
            <feGaussianBlur stdDeviation="0.5" />
          </filter>
        </defs>
        <rect width="100%" height="100%" fill="url(#net-grid)" filter="url(#net-blur)" />

        {/* Diagonal accent lines */}
        <line x1="0%" y1="20%" x2="60%" y2="0%" stroke="rgba(244,63,94,0.15)" strokeWidth="0.5" />
        <line x1="40%" y1="100%" x2="100%" y2="30%" stroke="rgba(244,63,94,0.12)" strokeWidth="0.5" />
        <line x1="0%" y1="60%" x2="80%" y2="100%" stroke="rgba(139,92,246,0.10)" strokeWidth="0.5" />
        <line x1="20%" y1="0%" x2="100%" y2="80%" stroke="rgba(244,63,94,0.08)" strokeWidth="0.5" />
      </svg>
    </div>
  )
})
