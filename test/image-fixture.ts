import type { ArtDirection } from "../src/images/brief";

export const creativeDirection = {
  concepts: [
    { name: "Unbound workspace", idea: "A folded paper room opens into connected workspaces", strength: "A concrete metaphor for flexibility", weakness: "The connection needs clear visual continuity" },
    { name: "Planning table", idea: "A sculptural network laid out on a planning table", strength: "Makes preparation tangible", weakness: "Less expressive of flexible work" },
    { name: "Connected places", idea: "An editorial collage connects different work settings", strength: "Immediately communicates location flexibility", weakness: "Can become cluttered" },
  ],
  selectedConcept: 0,
  selectionReason: "The folded room communicates flexible working with a single memorable subject. Keep the connections clear and the scene uncluttered.",
  artDirection: {
    medium: "Tactile paper sculpture", scene: "A paper office unfolding into connected workspaces",
    composition: "One large folded room on a diagonal, with generous negative space",
    palette: "Cobalt and warm orange on ivory", lighting: "Directional studio light with textured shadows", textMode: "headline",
  } as ArtDirection,
};
