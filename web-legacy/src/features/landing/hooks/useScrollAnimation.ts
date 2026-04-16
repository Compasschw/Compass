import { useEffect, useRef, useState } from 'react';

/**
 * Returns a ref and visibility flag. When the element enters the viewport
 * (15% intersection), `isVisible` flips to true and stays true.
 */
export function useScrollAnimation<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.unobserve(element);
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, isVisible };
}
