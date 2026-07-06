import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * A 3D CSS die that tumbles while `rolling` and settles on `value` when the
 * result is known. No dependencies — pure transforms. The server sends the real
 * die faces, so the cube lands on the actual rolled value.
 */

// Pip cell indices (3x3 grid, row-major) lit for each face value.
const PIPS: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 3, 6, 2, 5, 8],
};

// Rotation (deg) that brings each face to the front of the cube.
const FACE: Record<number, { x: number; y: number }> = {
    1: { x: 0, y: 0 },
    2: { x: -90, y: 0 },
    3: { x: 0, y: -90 },
    4: { x: 0, y: 90 },
    5: { x: 90, y: 0 },
    6: { x: 0, y: 180 },
};

// Placement transform for each face on the cube.
const placement = (val: number, half: number): string => {
    switch (val) {
        case 1: return `translateZ(${half}px)`;
        case 6: return `rotateY(180deg) translateZ(${half}px)`;
        case 3: return `rotateY(90deg) translateZ(${half}px)`;
        case 4: return `rotateY(-90deg) translateZ(${half}px)`;
        case 2: return `rotateX(90deg) translateZ(${half}px)`;
        default: return `rotateX(-90deg) translateZ(${half}px)`; // 5
    }
};

// Smallest rotation >= current that lands the face the right way up, plus spins.
const settle = (current: number, base: number, spins = 2): number =>
    base + 360 * (Math.ceil((current - base) / 360) + spins);

function Die({ value, rolling, size }: { value?: number; rolling: boolean; size: number }) {
    const half = size / 2;
    const [rot, setRot] = useState({ x: -20, y: -20 });

    useEffect(() => {
        if (rolling) {
            const id = setInterval(() => {
                setRot((r) => ({ x: r.x + 250 + Math.random() * 200, y: r.y + 250 + Math.random() * 200 }));
            }, 140);
            return () => clearInterval(id);
        }
        if (value && FACE[value]) {
            const base = FACE[value];
            // Defer a frame so the transition animates from the tumble's last frame.
            const t = setTimeout(() => setRot((r) => ({ x: settle(r.x, base.x), y: settle(r.y, base.y) })), 16);
            return () => clearTimeout(t);
        }
    }, [rolling, value, size]);

    const cubeStyle: CSSProperties = {
        position: 'relative',
        width: size,
        height: size,
        transformStyle: 'preserve-3d',
        transform: `translateZ(-${half}px) rotateX(${rot.x}deg) rotateY(${rot.y}deg)`,
        transition: rolling ? 'transform 0.14s linear' : 'transform 0.75s cubic-bezier(0.2, 0.85, 0.3, 1)',
    };

    const pip = (
        <span style={{ width: Math.max(4, size * 0.16), height: Math.max(4, size * 0.16), borderRadius: '50%', background: '#1e293b', alignSelf: 'center', justifySelf: 'center' }} />
    );

    return (
        <div style={{ perspective: size * 4, width: size, height: size, display: 'inline-block' }}>
            <div style={cubeStyle}>
                {[1, 2, 3, 4, 5, 6].map((val) => (
                    <div
                        key={val}
                        style={{
                            position: 'absolute',
                            width: size,
                            height: size,
                            boxSizing: 'border-box',
                            transform: placement(val, half),
                            background: 'linear-gradient(135deg, #ffffff, #e9eef5)',
                            border: '1px solid #cbd5e1',
                            borderRadius: size * 0.18,
                            display: 'grid',
                            gridTemplateColumns: 'repeat(3, 1fr)',
                            gridTemplateRows: 'repeat(3, 1fr)',
                            padding: size * 0.12,
                            boxShadow: 'inset 0 0 6px rgba(15,23,42,0.12)',
                        }}
                    >
                        {Array.from({ length: 9 }, (_, i) => (
                            <span key={i} style={{ display: 'grid' }}>{PIPS[val]!.includes(i) ? pip : null}</span>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

interface DiceRollProps {
    die1?: number;
    die2?: number;
    rolling: boolean;
    size?: number;
}

export default function DiceRoll({ die1, die2, rolling, size = 56 }: DiceRollProps) {
    return (
        <div style={{ display: 'flex', gap: size * 0.4, justifyContent: 'center', alignItems: 'center', padding: '0.5rem 0' }}>
            <Die value={die1} rolling={rolling} size={size} />
            <Die value={die2} rolling={rolling} size={size} />
        </div>
    );
}
