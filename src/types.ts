export interface AbstractNode {
  tag: string;
  attrs: {
    [key: string]: string;
  };
  children: AbstractNode[];
}

export interface IconDefinition extends AbstractNode {
  name: string; // kebab-case-style
  theme: ThemeType;
}

export type ThemeType = 'fill' | 'outline' | 'twotone';

export interface IconDefinitionGetter {
  (primaryColor: string, secondaryColor: string): IconDefinition;
  name: string; // kebab-case-style
  theme: ThemeType;
}

export interface Manifest {
  fill: string[];
  outline: string[];
  twotone: string[];
}
