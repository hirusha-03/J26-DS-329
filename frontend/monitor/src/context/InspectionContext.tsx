'use client';

import React, { createContext, useContext, useState, ReactNode } from 'react';

export interface InspectionFormState {
  // Step 1 — Plant selector
  zone: string | null;           // 'A' | 'B' | 'C' | 'D'
  block: string | null;          // '01' – '19'
  plant_number: number | null;   // integer
  plant_id: string | null;       // 'A01-P100'

  // Step 2 — Basic info
  common_name: string;
  latin_name: string;
  variety: string;
  plant_type: string;
  purchase_date: string | null;
  planted_date: string | null;
  purchased_from: string;
  purchase_condition: string | null; // '<75%' | '<50%' | '>75%' | '>50%'
  max_height: number | null; // max cutting height in cm

  // Step 3 — Care & environment
  watering_status: string | null; // 'Dry out' | 'Partially dry' | 'Keep moist' | 'High humidity'
  sunlight_level: string | null;  // 'Bright' | 'Bright indirect' | 'Medium' | 'Low'
  sunlight_lux: string | null;
  shade_level: string | null;     // 'Shade <75%' | 'Shade >75%' | 'Partial <50%' | 'Partial >50%'
  shade_percentage: string | null;
  soil_pH: number;
  soil_pH_recorded_at: string | null;
  temperature_c: number | null;
  temperature_recorded_at: string | null;
  humidity_pct: number | null;
  humidity_recorded_at: string | null;
  soil_type: string;             // 'Standard' | 'Cactus' | 'Acidic' | 'Orchid'
  fertiliser_type: string[];      // Array of: 'All purpose' | 'Cactus' | 'Acidic' | 'Orchid'
  last_fertilised: string | null;
  fertiliser_used: string;       // free text

  // Step 4 — Growth tracker
  vine_height_cm: number | null;
  height_delta_cm: number | null;
  foliage_color: string | null;  // 'Green' | 'Yellow' | 'Brown' | 'Red' | 'Mixed'
  planting_arrangement: string | null; // 'Square' | 'Rectangular' | etc.

  // Step 5 — Photo & submit
  photo_file: File | null;
  photo_filename: string | null;
  field_notes: string;
}

export const initialFormState: InspectionFormState = {
  zone: 'A',
  block: '01',
  plant_number: 1,
  plant_id: 'A01-P001',

  common_name: 'Vanilla',
  latin_name: 'Vanilla Planifolia',
  variety: 'Local',
  plant_type: 'Cutting',
  purchase_date: null,
  planted_date: null,
  purchased_from: 'Goomaraya, Kandy District',
  purchase_condition: null,
  max_height: null,

  watering_status: null,
  sunlight_level: null,
  sunlight_lux: null,
  shade_level: null,
  shade_percentage: null,
  soil_pH: 6.2,
  soil_pH_recorded_at: null,
  temperature_c: null,
  temperature_recorded_at: null,
  humidity_pct: null,
  humidity_recorded_at: null,
  soil_type: 'Acidic',
  fertiliser_type: [],
  last_fertilised: null,
  fertiliser_used: '',

  vine_height_cm: null,
  height_delta_cm: null,
  foliage_color: null,
  planting_arrangement: null,

  photo_file: null,
  photo_filename: null,
  field_notes: '',
};

interface InspectionContextType {
  formData: InspectionFormState;
  updateForm: (updates: Partial<InspectionFormState>) => void;
  resetForm: () => void;
}

const InspectionContext = createContext<InspectionContextType | null>(null);

export function InspectionProvider({ children }: { children: ReactNode }) {
  const [formData, setFormData] = useState<InspectionFormState>(initialFormState);

  const updateForm = (updates: Partial<InspectionFormState>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  };

  const resetForm = () => {
    setFormData(initialFormState);
  };

  return (
    <InspectionContext.Provider value={{ formData, updateForm, resetForm }}>
      {children}
    </InspectionContext.Provider>
  );
}

export function useInspection() {
  const context = useContext(InspectionContext);
  if (!context) {
    throw new Error('useInspection must be used within an InspectionProvider');
  }
  return context;
}
