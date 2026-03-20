import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { GraphControls } from '../GraphControls.tsx';

function makeCyMock() {
  const zoom = vi.fn();
  // cy.zoom() used as getter/setter: when called with no args returns current zoom level
  zoom.mockReturnValue(1.0);
  return {
    fit: vi.fn(),
    zoom,
    center: vi.fn(),
  };
}

describe('GraphControls', () => {
  let cyMock: ReturnType<typeof makeCyMock>;
  let cyRef: React.RefObject<typeof cyMock>;

  beforeEach(() => {
    cyMock = makeCyMock();
    cyRef = { current: cyMock } as unknown as React.RefObject<typeof cyMock>;
  });

  it('renders 4 control buttons', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(4);
  });

  it('has Fit to screen button', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    expect(screen.getByTitle('Fit to screen')).toBeInTheDocument();
  });

  it('has Zoom in button', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    expect(screen.getByTitle('Zoom in')).toBeInTheDocument();
  });

  it('has Zoom out button', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    expect(screen.getByTitle('Zoom out')).toBeInTheDocument();
  });

  it('has Reset view button', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    expect(screen.getByTitle('Reset view')).toBeInTheDocument();
  });

  it('calls cy.fit() when fit button is clicked', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    fireEvent.click(screen.getByTitle('Fit to screen'));
    expect(cyMock.fit).toHaveBeenCalledOnce();
  });

  it('calls cy.zoom() with increased value when zoom-in is clicked', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    fireEvent.click(screen.getByTitle('Zoom in'));
    // zoom() was called as getter (returns 1.0), then called with 1.0 * 1.2 = 1.2
    expect(cyMock.zoom).toHaveBeenCalledWith(1.2);
  });

  it('calls cy.zoom() with decreased value when zoom-out is clicked', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    fireEvent.click(screen.getByTitle('Zoom out'));
    // zoom() was called as getter (returns 1.0), then called with 1.0 / 1.2 ≈ 0.833
    expect(cyMock.zoom).toHaveBeenCalledWith(1.0 / 1.2);
  });

  it('calls cy.fit() and cy.zoom(1) when reset is clicked', () => {
    render(<GraphControls cyInstanceRef={cyRef as React.RefObject<any>} />);
    fireEvent.click(screen.getByTitle('Reset view'));
    expect(cyMock.fit).toHaveBeenCalledOnce();
    expect(cyMock.zoom).toHaveBeenCalledWith(1);
  });

  it('does not throw when cyInstanceRef.current is null', () => {
    const nullRef = { current: null } as React.RefObject<any>;
    render(<GraphControls cyInstanceRef={nullRef} />);
    expect(() => fireEvent.click(screen.getByTitle('Fit to screen'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTitle('Zoom in'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTitle('Zoom out'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTitle('Reset view'))).not.toThrow();
  });
});
